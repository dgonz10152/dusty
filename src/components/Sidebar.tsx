import { useState, type DragEvent } from "react";
import { Menu } from "@tauri-apps/api/menu";
import { ChevronRight, Ellipsis, Folder as FolderIcon, FolderPlus, Settings as SettingsIcon, SquarePen, Trash2 } from "lucide-react";
import { createFolder, deleteFolder, moveSession, renameFolder, type Folder, type Session } from "../db";

const DRAG_TYPE = "application/x-dusty-lesson";
const COLLAPSED_KEY = "dusty.collapsedFolders";

function relativeTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

type Props = {
  sessions: Session[];
  folders: Folder[];
  activeId: string | null;
  running: (sid: string) => boolean;
  onSelect: (sid: string | null) => void;
  onDelete: (sid: string) => void;
  onChange: () => void;
  onOpenSettings: () => void;
};

export default function Sidebar({ sessions, folders, activeId, running, onSelect, onDelete, onChange, onOpenSettings }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [editing, setEditing] = useState<string | null>(null);
  // The folder id a lesson is being dragged over; "" is the top level.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function toggle(id: string) {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Collapsed state is a convenience; losing it is fine.
    }
  }

  async function newFolder(moveId?: string) {
    const folder = await createFolder("New folder");
    if (moveId) await moveSession(moveId, folder.id);
    setEditing(folder.id);
    onChange();
  }

  async function move(sid: string, folderId: string | null) {
    await moveSession(sid, folderId);
    onChange();
  }

  async function commitRename(folder: Folder, name: string) {
    setEditing(null);
    if (name.trim() && name.trim() !== folder.name) {
      await renameFolder(folder.id, name.trim());
      onChange();
    }
  }

  // ponytail: menus aren't closed after use; each holds a few native items until the window closes
  async function lessonMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    e.stopPropagation();
    const menu = await Menu.new({
      items: [
        {
          text: "Move to",
          items: [
            { text: "No folder", checked: s.folder_id === null, action: () => move(s.id, null) },
            ...folders.map((f) => ({ text: f.name, checked: s.folder_id === f.id, action: () => move(s.id, f.id) })),
            { item: "Separator" },
            { text: "New folder", action: () => newFolder(s.id) },
          ],
        },
        { item: "Separator" },
        { text: "Delete lesson", action: () => onDelete(s.id) },
      ],
    });
    await menu.popup();
  }

  async function folderMenu(e: React.MouseEvent, f: Folder) {
    e.preventDefault();
    e.stopPropagation();
    const menu = await Menu.new({
      items: [
        { text: "Rename", action: () => setEditing(f.id) },
        { text: "Delete folder", action: async () => (await deleteFolder(f.id), onChange()) },
      ],
    });
    await menu.popup();
  }

  const dropProps = (folderId: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropTarget !== folderId) setDropTarget(folderId);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === folderId ? null : t));
    },
    onDrop: (e: DragEvent) => {
      const sid = e.dataTransfer.getData(DRAG_TYPE);
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (sid && sessions.find((s) => s.id === sid)?.folder_id !== (folderId || null)) move(sid, folderId || null);
    },
  });

  const lessonRow = (s: Session, nested = false) => (
    <div
      key={s.id}
      role="button"
      tabIndex={0}
      draggable
      className={`session ${nested ? "nested" : ""} ${s.id === activeId ? "active" : ""}`}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(s.id)}
      onContextMenu={(e) => lessonMenu(e, s)}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDropTarget(null)}
    >
      <span className="session-title">{s.title}</span>
      {running(s.id) ? <span className="dot-pulse small" /> : <span className="session-time">{relativeTime(s.updated_at)}</span>}
      <button
        className="icon-btn session-delete"
        aria-label="Delete lesson"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(s.id);
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );

  const loose = sessions.filter((s) => !s.folder_id || !folders.some((f) => f.id === s.folder_id));

  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region />
      <button className="nav-item" onClick={() => onSelect(null)}>
        <SquarePen size={16} /> New lesson
      </button>
      <div className="sidebar-label">
        <span>Lessons</span>
        <button className="icon-btn" aria-label="New folder" title="New folder" onClick={() => newFolder()}>
          <FolderPlus size={14} />
        </button>
      </div>
      <nav className={`session-list ${dropTarget === "" ? "drop" : ""}`} {...dropProps("")}>
        {folders.map((f) => {
          const lessons = sessions.filter((s) => s.folder_id === f.id);
          const open = !collapsed.has(f.id);
          return (
            <div key={f.id} className={`folder ${dropTarget === f.id ? "drop" : ""}`} {...dropProps(f.id)}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                className="session folder-row"
                onClick={() => editing !== f.id && toggle(f.id)}
                onDoubleClick={() => setEditing(f.id)}
                onKeyDown={(e) => e.key === "Enter" && editing !== f.id && toggle(f.id)}
                onContextMenu={(e) => folderMenu(e, f)}
              >
                <ChevronRight size={14} className={`folder-chevron ${open ? "open" : ""}`} />
                <FolderIcon size={15} className="folder-icon" />
                {editing === f.id ? (
                  <input
                    className="folder-input"
                    defaultValue={f.name}
                    aria-label="Folder name"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(f, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="session-title">{f.name}</span>
                )}
                {!open && lessons.some((s) => running(s.id)) ? (
                  <span className="dot-pulse small" />
                ) : (
                  <span className="session-time">{lessons.length || ""}</span>
                )}
                <button className="icon-btn session-delete" aria-label="Folder options" onClick={(e) => folderMenu(e, f)}>
                  <Ellipsis size={14} />
                </button>
              </div>
              {open &&
                (lessons.length ? lessons.map((s) => lessonRow(s, true)) : <div className="folder-empty">Drag lessons here</div>)}
            </div>
          );
        })}
        {loose.map((s) => lessonRow(s))}
      </nav>
      <button className="nav-item" onClick={onOpenSettings}>
        <SettingsIcon size={16} /> Settings
      </button>
    </aside>
  );
}
