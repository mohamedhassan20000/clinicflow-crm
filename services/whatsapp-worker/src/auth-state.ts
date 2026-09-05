import { BufferJSON, initAuthCreds, proto } from "baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { decryptAuthValue, encryptAuthValue } from "./crypto.ts";
import type { Store } from "./store.ts";

/**
 * The production persistence for a clinic's WhatsApp device identity.
 *
 * This deliberately replaces Baileys' file-backed `useMultiFileAuthState`: a
 * directory of plaintext JSON on a container filesystem is neither durable
 * across a redeploy nor acceptable for a multi-tenant system. Instead every
 * value is:
 *
 *   * keyed by clinic, so one clinic's device identity is physically separate
 *     from another's and no query in this module omits the clinic id;
 *   * serialized with Baileys' own BufferJSON replacer, so binary key material
 *     round-trips exactly; and
 *   * sealed in the same AES-256-GCM envelope the application uses for channel
 *     credentials, so the database only ever holds ciphertext.
 *
 * Nothing here is ever returned over the worker's HTTP API.
 */

const CREDS_KEY_TYPE = "creds";
const CREDS_KEY_ID = "state";

export type LinkedDeviceAuthState = {
  state: AuthenticationState;
  /** False when this is a brand-new identity rather than a restored pairing. */
  restored: boolean;
  /** Persists the device identity after Baileys mutates it. */
  saveCreds: () => Promise<void>;
  /** Destroys everything stored for this clinic (used on logout). */
  clear: () => Promise<void>;
};

export async function useSupabaseAuthState(
  store: Store,
  clinicId: string,
  key: Buffer,
): Promise<LinkedDeviceAuthState> {
  const readValue = async (keyType: string, keyId: string): Promise<unknown> => {
    const stored = await store.readAuthValue(clinicId, keyType, keyId);
    if (!stored) return null;
    try {
      return JSON.parse(decryptAuthValue(stored, key), BufferJSON.reviver) as unknown;
    } catch {
      // A value we cannot decrypt or parse is treated as absent: Baileys will
      // regenerate what it can, and an unusable device identity surfaces as a
      // failed connection that the clinic can resolve by scanning again.
      return null;
    }
  };

  const storedCreds = (await readValue(CREDS_KEY_TYPE, CREDS_KEY_ID)) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = storedCreds ?? initAuthCreds();

  return {
    restored: storedCreds !== null,
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readValue(type, id);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              }
              if (value) result[id] = value as SignalDataTypeMap[typeof type];
            }),
          );
          return result;
        },
        async set(data) {
          const writes: Array<{ keyType: string; keyId: string; value: string }> = [];
          const deletes: Array<{ keyType: string; keyId: string }> = [];
          for (const [keyType, entries] of Object.entries(data)) {
            for (const [keyId, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) {
                deletes.push({ keyType, keyId });
                continue;
              }
              writes.push({
                keyType,
                keyId,
                value: encryptAuthValue(JSON.stringify(value, BufferJSON.replacer), key),
              });
            }
          }
          await store.writeAuthValues(clinicId, writes);
          await store.deleteAuthValues(clinicId, deletes);
        },
      },
    },
    async saveCreds() {
      await store.writeAuthValues(clinicId, [
        {
          keyType: CREDS_KEY_TYPE,
          keyId: CREDS_KEY_ID,
          value: encryptAuthValue(JSON.stringify(creds, BufferJSON.replacer), key),
        },
      ]);
    },
    async clear() {
      await store.clearAuth(clinicId);
    },
  };
}

/**
 * Runs one auth write, or refuses it because the start it belongs to is over.
 *
 * Returns `true` when the write was admitted and has completed, `false` when it
 * was refused. Never rejects on refusal — a revoked write is an expected
 * outcome, not a fault.
 */
export type AuthWriteGuard = (write: () => Promise<void>) => Promise<boolean>;

/**
 * Wraps an auth state so that every *write* it can perform is subject to a
 * guard, and stops for good once that guard starts refusing.
 *
 * This is the last line of the start/logout race. A start that was admitted and
 * then logged out mid-flight keeps running — the socket factory may still be
 * inside a handshake, Baileys may still be about to emit `creds.update`, and the
 * Signal key store writes on its own schedule — and every one of those paths
 * ends in a write to `whatsapp_linked_device_auth`. Cancelling the *start* is
 * therefore not enough on its own: the object those paths hold has to become
 * incapable of persisting anything.
 *
 * Reads stay open (they can only return what is already stored, and a refused
 * read would make Baileys regenerate key material rather than stop), and
 * `clear()` stays open because that is the teardown itself.
 */
export function revocableAuthState(
  auth: LinkedDeviceAuthState,
  guard: AuthWriteGuard,
): LinkedDeviceAuthState {
  const keys = auth.state.keys;
  return {
    restored: auth.restored,
    state: {
      creds: auth.state.creds,
      keys: {
        get: (type, ids) => keys.get(type, ids),
        async set(data) {
          // Baileys types this as `Awaitable<void>`; the guard wants a promise.
          await guard(async () => {
            await keys.set(data);
          });
        },
      },
    },
    async saveCreds() {
      await guard(() => auth.saveCreds());
    },
    clear: () => auth.clear(),
  };
}
