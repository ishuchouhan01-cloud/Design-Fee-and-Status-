'use client';

import { useRouter } from 'next/navigation';

export function ProjectPicker({
  projects,
  current,
  include,
}: {
  projects: { id: string; name: string }[];
  current: string;
  include?: string;
}) {
  const router = useRouter();
  return (
    <div className="flex items-end gap-2">
      <div>
        <label className="label" htmlFor="sched-project">
          Project
        </label>
        <select
          id="sched-project"
          className="select w-56"
          value={current}
          onChange={(e) => router.push(`/schedule?projectId=${e.target.value}${include ? `&include=${include}` : ''}`)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="sched-include">
          Show
        </label>
        <select
          id="sched-include"
          className="select w-56"
          value={include ?? 'PACKAGE,DELIVERABLE'}
          onChange={(e) => router.push(`/schedule?projectId=${current}&include=${e.target.value}`)}
        >
          <option value="PACKAGE,DELIVERABLE">Packages + deliverables</option>
          <option value="PACKAGE">Packages only</option>
          <option value="PACKAGE,DRAWING">Packages + drawings</option>
          <option value="PACKAGE,DELIVERABLE,DRAWING">Everything</option>
        </select>
      </div>
    </div>
  );
}
