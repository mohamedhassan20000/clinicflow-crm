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
  };

  class QueryBuilder {
    private operation: "select" | "insert" | "update" | "delete" = "select";

    constructor(private readonly table: string) {}

    select() {
      this.operation = "select";
      return this;
    }

    insert() {
      this.operation = "insert";
      return this;
    }

    update() {
      this.operation = "update";
      return this;
    }

    delete() {
      this.operation = "delete";
      return this;
    }

    eq() {
      return this;
    }

    is() {
      return this;
    }

    not() {
      return this;
    }

    gt() {
      return this;
    }

    gte() {
      return this;
    }

    lte() {
      return this;
    }

    order() {
      return this;
    }

    limit() {
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
  }

  function reset() {
    state.authedUser = defaultAuthedUser();
    state.rpcResults = {};
    state.tableResults = {};
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
    state.requireRole.mockResolvedValue(state.authedUser);
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
