import { ConfirmModal } from "./ConfirmModal";

/**
 * "Uninstall X?" / "Revert X to the built-in version?" — the one confirmation
 * before a plugin is removed, shared by the Extensions view and the sidebar's
 * plugin menu so the two can't drift.
 */
export function UninstallPluginConfirm({ name, revertsToBuiltin, onCancel, onConfirm }: {
  name: string;
  /** A user copy over a bundled plugin: removing it brings the bundled one back. */
  revertsToBuiltin?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal
      title={revertsToBuiltin ? `Revert ${name} to the built-in version?` : `Uninstall ${name}?`}
      messageClassName="delete-confirm-warning"
      message={revertsToBuiltin
        ? `This removes the update you installed. ${name} keeps running, as the version that came with Vibo, and keeps its settings. Check for updates to get the newer one back.`
        : `This removes ${name} from this device. You can reinstall it from the gallery later.`}
      destructive
      autoFocusConfirm
      confirmLabel={revertsToBuiltin ? "Revert" : "Uninstall"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
