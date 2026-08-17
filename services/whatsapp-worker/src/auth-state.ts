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
