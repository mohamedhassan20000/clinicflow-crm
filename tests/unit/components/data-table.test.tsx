import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, TableEmptyState, TableSkeleton } from "@/components/shared/data-table";

describe("DataTable (Pre-P2 WS2 shared table system)", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "count", label: "Count", numeric: true },
  ];

  it("renders a real column header and rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[{ name: "Cardiology", count: 3 }]}
        empty={{ title: "No rows" }}
      />,
    );
    // <th scope="col"> for accessibility
    const header = screen.getByRole("columnheader", { name: "Name" });
    expect(header).toHaveAttribute("scope", "col");
    expect(screen.getByRole("cell", { name: "Cardiology" })).toBeInTheDocument();
    // numeric column is right-aligned + tabular
    expect(screen.getByRole("cell", { name: "3" }).className).toMatch(/text-end/);
  });

  it("renders the shared empty state instead of an empty table when there are no rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        empty={{ title: "No departments yet", description: "Create the first one." }}
      />,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No departments yet")).toBeInTheDocument();
    expect(screen.getByText("Create the first one.")).toBeInTheDocument();
  });

  it("custom render function overrides the default cell value", () => {
    render(
      <DataTable
        columns={[{ key: "name", label: "Name", render: (r) => <strong>{`✦ ${r.name}`}</strong> }]}
        rows={[{ name: "Neuro" }]}
        empty={{ title: "None" }}
      />,
    );
    expect(screen.getByText("✦ Neuro")).toBeInTheDocument();
  });

  it("TableEmptyState renders title, description, and action", () => {
    render(
      <TableEmptyState title="Nothing here" description="A hint" action={<button>Go</button>} />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("A hint")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });

  it("TableSkeleton renders the requested number of placeholder rows", () => {
    const { container } = render(<TableSkeleton columns={3} rows={4} />);
    // header row + 4 body rows = 5 flex rows
    expect(container.querySelectorAll(":scope > div > div").length).toBe(5);
  });
});
