import { vi } from "vitest";

type QueryResult = {
  data?: unknown;
  error?: { message?: string; code?: string } | null;
  count?: number | null;
};

type TableResults = Record<string, QueryResult | QueryResult[]>;

export type MockAuthedUser = {
  id: string;
  clinicId: string;
  role: "admin" | "receptionist" | "manager" | "doctor";
  departmentId?: string | null;
};

function defaultAuthedUser(): MockAuthedUser {
  return {
    id: "user-1",
    clinicId: "clinic-1",
    role: "receptionist",
    departmentId: null,
  };
}

export function createServerActionMocks() {
  const state = {
    authedUser: defaultAuthedUser(),
    rpcResults: {} as Record<string, QueryResult>,
    tableResults: {} as TableResults,
    rpc: vi.fn(),
    from: vi.fn(),
    authSignInWithPassword: vi.fn(),
    authGetUser: vi.fn(),
    authUpdateUser: vi.fn(),
    authSignOut: vi.fn(),
    adminCreateUser: vi.fn(),
    adminUpdateUserById: vi.fn(),
    adminDeleteUser: vi.fn(),
    storageFrom: vi.fn(),
    storageUpload: vi.fn(),
    storageRemove: vi.fn(),
    storageCreateSignedUrl: vi.fn(),
    storageCreateSignedUrls: vi.fn(),
    revalidatePath: vi.fn(),
    redirect: vi.fn(),
    requireRole: vi.fn(),
    queryLog: [] as {
      table: string;
      operation: "select" | "insert" | "update" | "delete";
      args: unknown[];
    }[],
    storageLog: [] as {
      bucket: string;
      operation: "upload" | "remove" | "createSignedUrl" | "createSignedUrls";
      args: unknown[];
    }[],
  };

  class QueryBuilder {
    private operation: "select" | "insert" | "update" | "delete" = "select";

    constructor(private readonly table: string) {}

    select(...args: unknown[]) {
      this.operation = "select";
      this.log(args);
      return this;
    }

    insert(...args: unknown[]) {
      this.operation = "insert";
      this.log(args);
      return this;
    }

    update(...args: unknown[]) {
      this.operation = "update";
      this.log(args);
      return this;
    }

    delete(...args: unknown[]) {
      this.operation = "delete";
      this.log(args);
      return this;
    }

    eq(...args: unknown[]) {
      this.logFilter("eq", args);
      return this;
    }

    is(...args: unknown[]) {
      this.logFilter("is", args);
      return this;
    }

    in(...args: unknown[]) {
      this.logFilter("in", args);
      return this;
    }

    not(...args: unknown[]) {
      this.logFilter("not", args);
      return this;
    }

    neq(...args: unknown[]) {
      this.logFilter("neq", args);
      return this;
    }

    gt(...args: unknown[]) {
      this.logFilter("gt", args);
      return this;
    }

    gte(...args: unknown[]) {
      this.logFilter("gte", args);
      return this;
    }

    lte(...args: unknown[]) {
      this.logFilter("lte", args);
      return this;
    }

    like(...args: unknown[]) {
      this.logFilter("like", args);
      return this;
    }

    or(...args: unknown[]) {
      this.logFilter("or", args);
      return this;
    }

    range(...args: unknown[]) {
      this.logFilter("range", args);
      return this;
    }

    order(...args: unknown[]) {
      this.logFilter("order", args);
      return this;
    }

    limit(...args: unknown[]) {
      this.logFilter("limit", args);
      return this;
    }

    single() {
      return Promise.resolve(this.result());
    }

    maybeSingle() {
      return Promise.resolve(this.result());
    }

    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?:
        | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) {
      return Promise.resolve(this.result()).then(onfulfilled, onrejected);
    }

    private result(): QueryResult {
      const configured =
        state.tableResults[`${this.table}.${this.operation}`] ??
        state.tableResults[this.table];
      if (Array.isArray(configured)) {
        return configured.shift() ?? { data: null, error: null };
      }
      return configured ?? { data: null, error: null };
    }

    private log(args: unknown[]) {
      state.queryLog.push({
        table: this.table,
        operation: this.operation,
        args,
      });
    }

    private logFilter(method: string, args: unknown[]) {
      state.queryLog.push({
        table: this.table,
        operation: this.operation,
        args: [method, ...args],
      });
    }
  }

  function reset() {
    state.authedUser = defaultAuthedUser();
    state.rpcResults = {};
    state.tableResults = {};
    state.queryLog = [];
    state.storageLog = [];
    state.rpc.mockReset();
    state.from.mockReset();
    state.authSignInWithPassword.mockReset();
    state.authGetUser.mockReset();
    state.authUpdateUser.mockReset();
    state.authSignOut.mockReset();
    state.adminCreateUser.mockReset();
    state.adminUpdateUserById.mockReset();
    state.adminDeleteUser.mockReset();
    state.storageFrom.mockReset();
    state.storageUpload.mockReset();
    state.storageRemove.mockReset();
    state.storageCreateSignedUrl.mockReset();
    state.storageCreateSignedUrls.mockReset();
    state.revalidatePath.mockReset();
    state.redirect.mockReset();
    state.requireRole.mockReset();
    state.requireRole.mockImplementation(() => Promise.resolve(state.authedUser));
    state.from.mockImplementation((table: string) => new QueryBuilder(table));
    state.rpc.mockImplementation((name: string) =>
      Promise.resolve(state.rpcResults[name] ?? { data: null, error: null }),
    );
    state.authSignInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: state.authedUser.id,
          email: "user@example.com",
        },
      },
      error: null,
    });
    state.authGetUser.mockResolvedValue({
      data: {
        user: {
          id: state.authedUser.id,
          email: "user@example.com",
        },
      },
      error: null,
    });
    state.authUpdateUser.mockResolvedValue({ data: {}, error: null });
    state.authSignOut.mockResolvedValue({ error: null });
    state.adminCreateUser.mockResolvedValue({
      data: { user: { id: "created-user-1" } },
      error: null,
    });
    state.adminUpdateUserById.mockResolvedValue({ data: {}, error: null });
    state.adminDeleteUser.mockResolvedValue({ data: {}, error: null });
    state.storageUpload.mockResolvedValue({ data: { path: "path" }, error: null });
    state.storageRemove.mockResolvedValue({ data: null, error: null });
    state.storageCreateSignedUrl.mockImplementation((path: string) =>
      Promise.resolve({
        data: { signedUrl: `https://signed.local/${path}` },
        error: null,
      }),
    );
    state.storageCreateSignedUrls.mockImplementation((paths: string[]) =>
      Promise.resolve({
        data: paths.map((path) => ({
          path,
          signedUrl: `https://signed.local/${path}`,
        })),
        error: null,
      }),
    );
    state.storageFrom.mockImplementation((bucket: string) => ({
      upload: (...args: unknown[]) => {
        state.storageLog.push({ bucket, operation: "upload", args });
        return state.storageUpload(...args);
      },
      remove: (...args: unknown[]) => {
        state.storageLog.push({ bucket, operation: "remove", args });
        return state.storageRemove(...args);
      },
      createSignedUrl: (...args: unknown[]) => {
        state.storageLog.push({ bucket, operation: "createSignedUrl", args });
        return state.storageCreateSignedUrl(...args);
      },
      createSignedUrls: (...args: unknown[]) => {
        state.storageLog.push({ bucket, operation: "createSignedUrls", args });
        return state.storageCreateSignedUrls(...args);
      },
    }));
  }

  function client() {
    return {
      from: state.from,
      rpc: state.rpc,
      storage: {
        from: state.storageFrom,
      },
      auth: {
        signInWithPassword: state.authSignInWithPassword,
        getUser: state.authGetUser,
        updateUser: state.authUpdateUser,
        signOut: state.authSignOut,
        admin: {
          createUser: state.adminCreateUser,
          updateUserById: state.adminUpdateUserById,
          deleteUser: state.adminDeleteUser,
        },
      },
    };
  }

  reset();

  return { state, reset, client };
}
