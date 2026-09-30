'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = { fontSize: 11, fill: '#6b7280' } as const;
const GRID = '#e5e7eb';

/** Plan / expected-by-today / delivered per quarter. */
export function QuarterChart({
  data,
}: {
  data: { label: string; plan: number; completed: number; forecast: number }[];
}) {
  return (
    <div style={{ width: '100%', height: 190 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }}
            labelStyle={{ fontWeight: 600 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="plan" name="Plan" fill="#9cb6f6" radius={[2, 2, 0, 0]} />
          <Bar dataKey="forecast" name="Forecast" fill="#3b62c4" radius={[2, 2, 0, 0]} />
          <Bar dataKey="completed" name="Delivered" fill="#127c4c" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DisciplineChart({
  data,
}: {
  data: { disciplineName: string; completionPercent: number; planned: number }[];
}) {
  return (
    <div style={{ width: '100%', height: Math.max(160, data.length * 26) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
          <YAxis
            type="category"
            dataKey="disciplineName"
            tick={AXIS}
            width={120}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }}
            formatter={(v: number, _n, p) => [`${v}% of ${p.payload.planned} items`, 'Delivered']}
          />
          <Bar dataKey="completionPercent" radius={[0, 2, 2, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.completionPercent >= 85 ? '#127c4c' : d.completionPercent >= 40 ? '#3b62c4' : '#b1660c'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CumulativeChart({
  data,
}: {
  data: { label: string; plan: number; actual: number }[];
}) {
  return (
    <div style={{ width: '100%', height: 190 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="plan" name="Cumulative plan" stroke="#3b62c4" strokeWidth={2} dot={false} />
          <Line
            type="monotone"
            dataKey="actual"
            name="Cumulative delivered"
            stroke="#127c4c"
            strokeWidth={2}
            dot={{ r: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
