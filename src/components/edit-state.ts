'use client';

/**
 * Edit Mode state shared by the menu and the table on one page: whether Edit
 * Mode is on, and whether a cell has unsaved changes (so leaving asks first).
 */
let editMode = false;
let dirty = 0;

export function setEditModeFlag(on: boolean) {
  editMode = on;
}
export function isEditMode() {
  return editMode;
}

/** A cell opened for editing counts itself in, and out when saved or cancelled. */
export function markDirty(on: boolean) {
  dirty = Math.max(0, dirty + (on ? 1 : -1));
}
export function hasUnsaved() {
  return dirty > 0;
}
export function resetDirty() {
  dirty = 0;
}

/** True when it is fine to leave: nothing unsaved, or the user agreed to discard it. */
export function confirmDiscard(): boolean {
  if (!hasUnsaved()) return true;
  const okToLeave = window.confirm('You have unsaved changes. Leave without saving them?');
  if (okToLeave) resetDirty();
  return okToLeave;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsaved()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
