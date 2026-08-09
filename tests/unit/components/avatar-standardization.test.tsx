import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

describe("shared avatar standardization", () => {
  it("provides the blurred circular fill used behind complete avatar images", () => {
    const { container } = render(
      <Avatar className="size-14">
        <AvatarImage src="data:image/png;base64,cGhvdG8=" alt="Patient" />
        <AvatarFallback>PT</AvatarFallback>
      </Avatar>,
    );

    const root = container.querySelector('[data-slot="avatar"]');
    const background = container.querySelector('[data-slot="avatar-image-background"]');

    expect(root).toHaveClass("overflow-hidden", "rounded-full");
    expect(background).toHaveClass("bg-cover", "blur-[3px]");
  });

  it("keeps fallback avatars available when no image is supplied", () => {
    const { getByText } = render(
      <Avatar>
        <AvatarFallback>MH</AvatarFallback>
      </Avatar>,
    );

    expect(getByText("MH")).toBeInTheDocument();
  });
});
