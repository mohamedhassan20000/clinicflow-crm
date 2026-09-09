/**
 * The Package Builder, as a contract.
 *
 * Everything asserted here is a property of the *form*: which services are
 * offerable on a line, what happens to lines when the department changes, how a
 * line's price is seeded, and how subtotals and the package total are derived.
 * The authority is still the database and the mutation —
 * `package_template_items` keys the clinic and the department into both of its
 * foreign keys, and `validateTemplateItems` re-checks the active flag, because
 * a dropdown is not an authority — and these tests are about the thing a person
 * actually operates.
 *
 * Two rules are worth stating out loud, because the whole design rests on them:
 *
 *   * **the service supplies a default, not a link.** Picking one seeds that
 *     line's package price from the service's current catalogue price and
 *     nothing else. `services.price` is never written, and the line's price is
 *     never recomputed from it afterwards — a package is a commercial decision
 *     the clinic made on a day.
 *   * **derivation runs one way.** Lines are the input; the subtotal, the
 *     session count and the package total are outputs. Nothing edits a total
 *     and reprices a line from it, so the two can never chase each other.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PackageTemplateForm,
  type PackageServiceOption,
} from "@/components/settings/packages/package-template-form";

const DEPARTMENTS = [
  { id: "dept-physio", name: "Physical Therapy", color: "#0891b2" },
  { id: "dept-derma", name: "Dermatology", color: "#22d3ee" },
];

const SERVICES: PackageServiceOption[] = [
  { id: "svc-rehab", name: "Rehabilitation Session", department_id: "dept-physio", price: 100 },
  { id: "svc-posture", name: "Posture Correction", department_id: "dept-physio", price: 140 },
  { id: "svc-acne", name: "Acne Treatment", department_id: "dept-derma", price: 250 },
];

function setup(defaults?: Parameters<typeof PackageTemplateForm>[0]["defaults"]) {
  const action = vi.fn(async () => ({ success: true }));
  render(
    <PackageTemplateForm
      action={action}
      departments={DEPARTMENTS}
      services={SERVICES}
      defaults={defaults}
      submitLabel="Create template"
    />,
  );
  return { action };
}

/** Opens a shadcn Select by its trigger's accessible name and clicks one option. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  option: RegExp,
) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

async function chooseDepartment(
  user: ReturnType<typeof userEvent.setup>,
  option: RegExp,
) {
  await choose(user, screen.getByRole("combobox", { name: /Department/i }), option);
}

/** Every line currently on the form, as its row container. */
function rows(): HTMLElement[] {
  return screen
    .queryAllByRole("combobox", { name: /Service \(optional\)/i })
    .map((trigger) => trigger.closest("div.grid") as HTMLElement);
}

async function addRow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Add service/i }));
}

/** The values a submit would actually carry, read off the rendered inputs. */
function submittedValues(name: string): string[] {
  return [...document.querySelectorAll(`[name="${name}"]`)].map(
    (node) => (node as HTMLInputElement).value,
  );
}

function field(name: string): HTMLInputElement {
  return document.querySelector(`[name="${name}"]`) as HTMLInputElement;
}

describe("adding lines is gated on a department, because a service belongs to one", () => {
  it("cannot add a line before a department is chosen", () => {
    setup();
    expect(screen.getByRole("button", { name: /Add service/i })).toBeDisabled();
    expect(screen.getByText(/Choose a department first/i)).toBeInTheDocument();
  });

  it("adds a line once a department is chosen", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    expect(rows()).toHaveLength(1);
  });

  it("offers only the chosen department's services on a line", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await user.click(rows()[0].querySelector("[role=combobox]") as HTMLElement);
    const options = screen.getAllByRole("option").map((node) => node.textContent);
    expect(options).toContain("Rehabilitation Session");
    expect(options).toContain("Posture Correction");
    // Another department's service is not offerable, because the database
    // refuses it: both of the item table's foreign keys carry department_id.
    expect(options).not.toContain("Acne Treatment");
  });

  it("cannot put the same service on two lines", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    await addRow(user);
    await user.click(rows()[1].querySelector("[role=combobox]") as HTMLElement);
    const taken = await screen.findByRole("option", { name: /Rehabilitation Session/ });
    // One line per service — the table's own `package_template_items_service_once`.
    expect(taken).toHaveAttribute("aria-disabled", "true");
  });
});

describe("a line's price is seeded from the service and then belongs to the package", () => {
  it("fills the line's price from the service's current catalogue price", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    expect(
      within(rows()[0]).getByRole("spinbutton", { name: /Package price \/ session/i }),
    ).toHaveValue(100);
  });

  it("shows the service's catalogue price as a reference, and states no saving", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    expect(within(rows()[0]).getByText(/Service price \/ session: 100/)).toBeInTheDocument();
    // A discount the clinic did not state is a discount this form invented.
    expect(document.body.textContent).not.toMatch(/saving|discount|you save/i);
  });

  it("keeps an edited line price, and submits it rather than the service's", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    const price = within(rows()[0]).getByRole("spinbutton", {
      name: /Package price \/ session/i,
    });
    await user.clear(price);
    await user.type(price, "80");
    expect(price).toHaveValue(80);
    // The package's number, submitted. The catalogue's 100 goes nowhere: this
    // form has no input that could write `services.price`, which is the point.
    expect(submittedValues("item_price_per_session")).toEqual(["80"]);
    expect(document.querySelector('[name="service_price"]')).toBeNull();
  });
});

describe("subtotals and the package total are derived from the lines, one way", () => {
  async function twoLines(user: ReturnType<typeof userEvent.setup>) {
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    const firstSessions = within(rows()[0]).getByRole("spinbutton", { name: /Sessions/i });
    await user.clear(firstSessions);
    await user.type(firstSessions, "5");

    await addRow(user);
    await choose(
      user,
      rows()[1].querySelector("[role=combobox]") as HTMLElement,
      /Posture Correction/,
    );
    const secondSessions = within(rows()[1]).getByRole("spinbutton", { name: /Sessions/i });
    await user.clear(secondSessions);
    await user.type(secondSessions, "3");
  }

  it("shows each line's subtotal as sessions x package price", async () => {
    const user = userEvent.setup();
    setup();
    await twoLines(user);
    expect(within(rows()[0]).getByText(/Subtotal: 500$/)).toBeInTheDocument();
    expect(within(rows()[1]).getByText(/Subtotal: 420$/)).toBeInTheDocument();
  });

  it("sums the package total from the line subtotals", async () => {
    const user = userEvent.setup();
    setup();
    await twoLines(user);
    // 5 × 100 + 3 × 140 = 920.
    expect(screen.getByTestId("package-total")).toHaveTextContent("920");
    expect(field("total_price")).toHaveValue("920");
  });

  it("derives the header's session count from the lines", async () => {
    const user = userEvent.setup();
    setup();
    await twoLines(user);
    expect(field("total_sessions")).toHaveValue("8");
  });

  it("offers no editable total while the package has lines, so nothing can cycle", async () => {
    const user = userEvent.setup();
    setup();
    await twoLines(user);
    // The total is rendered, but as a derived value — there is no spinbutton a
    // person could type into and have it reprice a line.
    expect(
      screen.queryByRole("spinbutton", { name: /Total price/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Summed from the service subtotals above/)).toBeInTheDocument();
  });

  it("recomputes the total when a line is removed", async () => {
    const user = userEvent.setup();
    setup();
    await twoLines(user);
    await user.click(within(rows()[1]).getByRole("button", { name: /Remove service/i }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("package-total")).toHaveTextContent("500");
  });
});

describe("zero lines is a package, and it is the legacy one", () => {
  it("keeps the editable session/price/total fields when there are no lines", () => {
    setup();
    expect(screen.getByRole("spinbutton", { name: /Total sessions/i })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /^Price \/ session/i })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Total price/i })).toBeInTheDocument();
    expect(document.querySelector('[name="item_service_id"]')).toBeNull();
  });

  it("still derives the legacy total one way, and stops on an override", async () => {
    const user = userEvent.setup();
    setup();
    const sessions = screen.getByRole("spinbutton", { name: /Total sessions/i });
    const each = screen.getByRole("spinbutton", { name: /^Price \/ session/i });
    await user.type(sessions, "10");
    await user.type(each, "90");
    expect(screen.getByRole("spinbutton", { name: /Total price/i })).toHaveValue(900);

    const total = screen.getByRole("spinbutton", { name: /Total price/i });
    await user.clear(total);
    await user.type(total, "800");
    await user.clear(sessions);
    await user.type(sessions, "12");
    // The clinic's deliberate package price survives; it is not rewritten by
    // the derivation it just overrode.
    expect(total).toHaveValue(800);
  });

  it("renders an existing department-only package unchanged", () => {
    setup({
      id: "tpl-legacy",
      department_id: "dept-physio",
      items: [],
      name: "10-session physio package",
      total_sessions: 10,
      price_per_session: 90,
      total_price: 850,
    });
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole("spinbutton", { name: /Total price/i })).toHaveValue(850);
    expect(document.querySelector('[name="item_service_id"]')).toBeNull();
  });
});

describe("changing the department drops lines it cannot legally hold", () => {
  it("removes a line whose service belongs to the department just left", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    await choose(
      user,
      rows()[0].querySelector("[role=combobox]") as HTMLElement,
      /Rehabilitation Session/,
    );
    expect(submittedValues("item_service_id")).toEqual(["svc-rehab"]);

    await chooseDepartment(user, /Dermatology/);
    // Not merely stale — wrong, and unrepresentable: the item table's foreign
    // keys carry the package's department, so this row could not be stored.
    expect(rows()).toHaveLength(0);
    expect(submittedValues("item_service_id")).toEqual([]);
  });
});

describe("an unfinished line is not a line", () => {
  it("submits nothing for a row whose service is still unpicked", async () => {
    const user = userEvent.setup();
    setup();
    await chooseDepartment(user, /Physical Therapy/);
    await addRow(user);
    expect(rows()).toHaveLength(1);
    // Rendered, but carrying no payload: a person part-way through adding a
    // line has not added one.
    expect(submittedValues("item_service_id")).toEqual([]);
    expect(submittedValues("item_sessions")).toEqual([]);
    expect(screen.queryByTestId("package-total")).not.toBeInTheDocument();
  });
});

describe("an existing multi-service package loads its lines back", () => {
  it("renders one row per stored line, with its stored numbers", () => {
    setup({
      id: "tpl-rehab",
      department_id: "dept-physio",
      name: "Rehabilitation package",
      items: [
        { service_id: "svc-rehab", sessions: 5, price_per_session: 1300 },
        { service_id: "svc-posture", sessions: 3, price_per_session: 1800 },
      ],
      total_sessions: 8,
      price_per_session: null,
      total_price: 11900,
    });
    expect(rows()).toHaveLength(2);
    expect(submittedValues("item_service_id")).toEqual(["svc-rehab", "svc-posture"]);
    expect(submittedValues("item_sessions")).toEqual(["5", "3"]);
    // The clinic's stored package prices, not the catalogue's 100 and 140.
    expect(submittedValues("item_price_per_session")).toEqual(["1300", "1800"]);
    expect(screen.getByTestId("package-total")).toHaveTextContent("11900");
  });
});
