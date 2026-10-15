import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Home from "@/app/page";

it("renders the home placeholder", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { name: "OW Slido" })).toBeTruthy();
});
