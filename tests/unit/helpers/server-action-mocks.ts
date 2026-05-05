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
    authGetUser: vi.fn(),
    authUpdateUser: vi.fn(),
    authSignOut: vi.fn(),
    adminCreateUser: vi.fn(),
    adminUpdateUserById: vi.fn(),
    adminDeleteUser: vi.fn(),
    revalidatePath: vi.fn(),
    redirect: vi.fn(),
    requireRole: vi.fn(),
    queryLog: [] as {
      table: string;
      operation: "select" | "insert" | "update" | "delete";
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

    not(...args: unknown[]) {
      this.logFilter("not", args);
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
    state.rpc.mockReset();
    state.from.mockReset();
    state.authGetUser.mockReset();
    state.authUpdateUser.mockReset();
    state.authSignOut.mockReset();
    state.adminCreateUser.mockReset();
    state.adminUpdateUserById.mockReset();
    state.adminDeleteUser.mockReset();
    state.revalidatePath.mockReset();
    state.redirect.mockReset();
    state.requireRole.mockReset();
    state.requireRole.mockImplementation(() => Promise.resolve(state.authedUser));
    state.from.mockImplementation((table: string) => new QueryBuilder(table));
    state.rpc.mockImplementation((name: string) =>
      Promise.resolve(state.rpcResults[name] ?? { data: null, error: null }),
    );
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
  }

  function client() {
    return {
      from: state.from,
      rpc: state.rpc,
      auth: {
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
