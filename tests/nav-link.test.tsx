import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { NavLink } from "@/components/ui/nav-link";

afterEach(cleanup);

const current = (name: string) => screen.getByRole("link", { name }).getAttribute("aria-current");

describe("NavLink", () => {
  it("marks the link for the page and for pages below it", () => {
    pathname = "/dashboard/members";
    render(
      <>
        <NavLink href="/dashboard">Events</NavLink>
        <NavLink href="/dashboard/members">Members</NavLink>
        <NavLink href="/">Join</NavLink>
      </>,
    );
    expect(current("Members")).toBe("page");
    expect(current("Events")).toBeNull();
    expect(current("Join")).toBeNull();
  });

  it("keeps Events current on an event page and /dashboard itself, but not on other dashboard pages", () => {
    const view = () => (
      <NavLink href="/dashboard" alsoUnder={["/dashboard/events"]}>
        Events
      </NavLink>
    );
    pathname = "/dashboard/events/abc/moderate";
    const { unmount } = render(view());
    expect(current("Events")).toBe("page");
    unmount();
    pathname = "/dashboard";
    const second = render(view());
    expect(current("Events")).toBe("page");
    second.unmount();
    pathname = "/dashboard/plan";
    render(view());
    expect(current("Events")).toBeNull();
  });

  it("matches the join link on the home page only", () => {
    pathname = "/";
    render(<NavLink href="/">Join</NavLink>);
    expect(current("Join")).toBe("page");
  });
});
