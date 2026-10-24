// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the Finora placeholder", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /know exactly where your money is/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Finora", { selector: "header span" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: /design principles/i }),
    ).toBeInTheDocument();
  });
});
