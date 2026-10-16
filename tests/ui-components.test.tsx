import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to type=button and secondary", () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.dataset.variant).toBe("secondary");
  });

  it("is disabled and marked busy while busy, and ignores clicks", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" busy onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("respects disabled without aria-busy", () => {
    render(<Button disabled>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("TextField", () => {
  it("links label, hint and error", () => {
    render(<TextField label="Name" hint="Shown to others" error="Required" />);
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });
});

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        title="Delete event"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      >
        <button>First</button>
        <button>Last</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(<Dialog open={false} title="T" onClose={() => {}}>x</Dialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses inside, traps Tab, closes on Escape and returns focus", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Delete event" });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
