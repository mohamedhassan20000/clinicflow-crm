import { vi } from "vitest";

type QueryResult = {
  data?: unknown;
  error?: { message?: string; code?: string } | null;
};

type TableResults = Record<string, QueryResult | QueryResult[]>;

export type MockAuthedUser = {
  id: string;
  clinicId: string;
  role: "admin" | "receptionist" | "manager" | "doctor";
  departmentId?: string | null;
};

export function createServerActionMocks() {
  const state = {
    authedUser: {
      id: "user-1",
      clinicId: "clinic-1",
      role: "receptionist",
      departmentId: null,
    } satisfies MockAuthedUser,
    rpcResults: {} as Record<string, QueryResult>,
    tableResults: {} as TableResults,
    rpc: vi.fn(),
    from: vi.fn(),
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
    state.authedUser = {
      id: "user-1",
      clinicId: "clinic-1",
      role: "receptionist",
      departmentId: null,
    };
    state.rpcResults = {};
    state.tableResults = {};
    state.rpc.mockReset();
    state.from.mockReset();
    state.revalidatePath.mockReset();
    state.redirect.mockReset();
    state.requireRole.mockReset();
    state.requireRole.mockResolvedValue(state.authedUser);
    state.from.mockImplementation((table: string) => new QueryBuilder(table));
    state.rpc.mockImplementation((name: string) =>
      Promise.resolve(state.rpcResults[name] ?? { data: null, error: null }),
    );
  }

  function client() {
    return {
      from: state.from,
      rpc: state.rpc,
    };
  }

  reset();

  return { state, reset, client };
}
