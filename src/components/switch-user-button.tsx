'use client';

import { switchUser } from '@/components/nav';
import { DFS_LABEL } from '@/lib/labels';

export function SwitchUserButton() {
  return (
    <button type="button" className="btn btn-primary" onClick={() => void switchUser()}>
      {DFS_LABEL.switchUser}
    </button>
  );
}
