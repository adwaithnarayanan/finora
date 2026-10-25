// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomeOverview } from "./home-overview";

describe("HomeOverview", () => {
  it("renders the Finora placeholder content", () => {
    render(<HomeOverview />);
    expect(
      screen.getByRole("heading", { level: 1, name: /know exactly where your money is/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /design principles/i })).toBeInTheDocument();
  });
});
