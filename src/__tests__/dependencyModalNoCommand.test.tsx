// A plugin-defined tool may name only a download page (whisper-cli has no
// package-manager command on any platform). The dialog must not draw an empty
// terminal box with a Copy button for it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DependencyModal } from "../components/DependencyModal";
import type { DependencyInfo } from "../hooks/useDependencies";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

afterEach(cleanup);

function dep(command: string, managedAvailable: boolean): DependencyInfo {
  return {
    name: "whisper-cli",
    description: "whisper.cpp speech recognition",
    status: "notFound",
    internalConsumers: [],
    pluginConsumers: [{ name: "Whisper Lyrics Sync", reason: "Listen to songs", required: true }],
    install: { macos: command, windows: command, linux: command, url: "https://github.com/outcast1000/viboplr-whisper-cpp/releases" },
    managedAvailable,
  } as unknown as DependencyInfo;
}

const noop = () => {};

describe("DependencyModal without a terminal command", () => {
  it("shows no terminal box and points at the download page when it can install itself", () => {
    render(<DependencyModal dep={dep("", true)} feature="Sync lyrics with Whisper" onInstall={async () => null} onDismiss={noop} onRecheck={noop} />);
    expect(screen.queryByText("Copy")).toBeNull();
    expect(screen.queryByText(/via terminal/)).toBeNull();
    expect(screen.getByText("its download page")).toBeTruthy();
    expect(screen.getByText("Install for me")).toBeTruthy();
  });

  it("leaves the Download Page button as the only route when it can't", () => {
    render(<DependencyModal dep={dep("", false)} feature="Sync lyrics with Whisper" onDismiss={noop} onRecheck={noop} />);
    expect(screen.queryByText("Copy")).toBeNull();
    expect(screen.queryByText("its download page")).toBeNull();
    expect(screen.getByText("Download Page")).toBeTruthy();
  });

  it("still shows the command when there is one", () => {
    render(<DependencyModal dep={dep("brew install whisper-cpp", true)} feature="Sync lyrics with Whisper" onInstall={async () => null} onDismiss={noop} onRecheck={noop} />);
    expect(screen.getByText("brew install whisper-cpp")).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
  });
});
