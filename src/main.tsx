import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Label from "@radix-ui/react-label";
import * as Progress from "@radix-ui/react-progress";
import * as Select from "@radix-ui/react-select";
import * as Toast from "@radix-ui/react-toast";
import { Check, ChevronDown, Clipboard, Download, KeyRound, Play } from "lucide-react";
import "./styles.css";

const STORAGE_KEY = "peak-sneak-google-api-key";
const ORIGIN_STORAGE_KEY = "peak-sneak-origin";
const DESTINATION_STORAGE_KEY = "peak-sneak-destination";

type TrafficModel = "BEST_GUESS" | "OPTIMISTIC" | "PESSIMISTIC";

type RouteRange = {
  optimistic: number;
  bestGuess: number;
  pessimistic: number;
};

type ResultRow = {
  datetime: string;
  toDestination: RouteRange | null;
  toOrigin: RouteRange | null;
};

type ToastState = {
  title: string;
  description: string;
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDatetimeValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sheetDatetime(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function axisTickLabel(datetime: string) {
  const date = new Date(datetime.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) {
    return { time: datetime, day: "" };
  }

  return {
    time: date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase(),
    day: date.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }).toLowerCase(),
  };
}

function secondsToMinutes(value: string) {
  return Math.round(Number(value.replace(/s$/, "")) / 60);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function numericValues(rows: ResultRow[]) {
  return rows.flatMap((row) =>
    [
      row.toDestination?.optimistic,
      row.toDestination?.bestGuess,
      row.toDestination?.pessimistic,
      row.toOrigin?.optimistic,
      row.toOrigin?.bestGuess,
      row.toOrigin?.pessimistic,
    ].filter((value): value is number => typeof value === "number")
  );
}

function formatRouteRange(range: RouteRange | null) {
  if (!range) return "";
  return `${range.optimistic}–${range.pessimistic} min, best ${range.bestGuess} min`;
}

function App() {
  const now = useMemo(() => new Date(), []);
  const defaultEarliest = useMemo(() => new Date(now.getTime() + 5 * 60 * 1000), [now]);
  const defaultLatest = useMemo(() => new Date(defaultEarliest.getTime() + 24 * 60 * 60 * 1000), [defaultEarliest]);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [rememberKey, setRememberKey] = useState(Boolean(localStorage.getItem(STORAGE_KEY)));
  const [origin, setOrigin] = useState(() => localStorage.getItem(ORIGIN_STORAGE_KEY) || "");
  const [destination, setDestination] = useState(() => localStorage.getItem(DESTINATION_STORAGE_KEY) || "");
  const [earliest, setEarliest] = useState(localDatetimeValue(defaultEarliest));
  const [latest, setLatest] = useState(localDatetimeValue(defaultLatest));
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);

  const tsv = useMemo(() => {
    const lines = [
      "datetime\tto destination optimistic\tto destination best guess\tto destination pessimistic\tto origin optimistic\tto origin best guess\tto origin pessimistic",
    ];
    for (const row of rows) {
      lines.push(
        [
          row.datetime,
          row.toDestination?.optimistic ?? "",
          row.toDestination?.bestGuess ?? "",
          row.toDestination?.pessimistic ?? "",
          row.toOrigin?.optimistic ?? "",
          row.toOrigin?.bestGuess ?? "",
          row.toOrigin?.pessimistic ?? "",
        ].join("\t")
      );
    }
    return lines.join("\n");
  }, [rows]);

  const progressPercent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  async function runForecast() {
    setError("");
    setRows([]);

    const key = apiKey.trim();
    if (!key) {
      setError("Enter a Google Maps API key.");
      return;
    }

    if (!origin.trim() || !destination.trim()) {
      setError("Enter both origin and destination.");
      return;
    }

    if (rememberKey) {
      localStorage.setItem(STORAGE_KEY, key);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }

    localStorage.setItem(ORIGIN_STORAGE_KEY, origin);
    localStorage.setItem(DESTINATION_STORAGE_KEY, destination);

    const start = new Date(earliest);
    const end = new Date(latest);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setError("Enter valid earliest departure and latest return times.");
      return;
    }

    if (end <= start) {
      setError("Latest return must be after earliest departure.");
      return;
    }

    const slotCount = Math.floor((end.getTime() - start.getTime()) / (intervalMinutes * 60 * 1000)) + 1;
    if (slotCount > 300) {
      setError("That window is large. Use a bigger interval or a shorter date range.");
      return;
    }

    setRunning(true);
    setProgress({ done: 0, total: slotCount });

    const nextRows: ResultRow[] = [];
    try {
      for (let i = 0; i < slotCount; i += 1) {
        const slot = new Date(start.getTime() + i * intervalMinutes * 60 * 1000);
        const departureTime = slot.toISOString();
        const [toDestination, toOrigin] = await Promise.all([
          fetchDurationRange({ key, origin, destination, departureTime }),
          fetchDurationRange({ key, origin: destination, destination: origin, departureTime }),
        ]);

        nextRows.push({
          datetime: sheetDatetime(slot),
          toDestination,
          toOrigin,
        });

        setRows([...nextRows]);
        setProgress({ done: i + 1, total: slotCount });
      }

      setToast({ title: "Forecast complete", description: `${slotCount} time slots generated.` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setRunning(false);
    }
  }

  async function copyTsv() {
    await navigator.clipboard.writeText(tsv);
    setToast({ title: "Copied", description: "TSV is ready to paste into Google Sheets." });
  }

  return (
    <Toast.Provider swipeDirection="right">
      <main className="app">
        <header className="topbar">
          <div>
            <h1>Traffic Forecast</h1>
          </div>
        </header>

        <div className="grid">
          <section className="panel form">
            <h2 className="section-title">Inputs</h2>

            <Field label="Google Maps API key">
              <div className="input-with-icon">
                <KeyRound size={17} aria-hidden="true" />
                <input
                  className="input bare"
                  type="password"
                  value={apiKey}
                  placeholder="Paste key"
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </Field>

            <p className="api-key-help">
              A demo key works for trying the app, but a key from your own Google Cloud account has a higher free daily allowance.{" "}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Create credentials
              </a>
            </p>

            <label className="check-row">
              <Checkbox.Root className="check-root" checked={rememberKey} onCheckedChange={(value) => setRememberKey(value === true)}>
                <Checkbox.Indicator>
                  <Check size={14} aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span>Remember key in this browser</span>
            </label>

            <Field label="Origin">
              <input
                className="input"
                value={origin}
                placeholder="Enter origin"
                onChange={(event) => {
                  setOrigin(event.target.value);
                  localStorage.setItem(ORIGIN_STORAGE_KEY, event.target.value);
                }}
              />
            </Field>

            <Field label="Destination">
              <input
                className="input"
                value={destination}
                placeholder="Enter destination"
                onChange={(event) => {
                  setDestination(event.target.value);
                  localStorage.setItem(DESTINATION_STORAGE_KEY, event.target.value);
                }}
              />
            </Field>

            <div className="datetime-grid">
              <Field label="Earliest departure">
                <input className="input" type="datetime-local" value={earliest} onChange={(event) => setEarliest(event.target.value)} />
              </Field>
              <Field label="Latest return">
                <input className="input" type="datetime-local" value={latest} onChange={(event) => setLatest(event.target.value)} />
              </Field>
            </div>

            <div className="single-control">
              <Field label="Interval">
                <RadixSelect value={String(intervalMinutes)} onValueChange={(value) => setIntervalMinutes(Number(value))}>
                  <Select.Item className="select-item" value="15"><Select.ItemText>15 minutes</Select.ItemText></Select.Item>
                  <Select.Item className="select-item" value="30"><Select.ItemText>30 minutes</Select.ItemText></Select.Item>
                  <Select.Item className="select-item" value="60"><Select.ItemText>60 minutes</Select.ItemText></Select.Item>
                </RadixSelect>
              </Field>
            </div>

            <div className="controls">
              <button className="button primary" onClick={runForecast} disabled={running}>
                <Play size={16} aria-hidden="true" />
                {running ? "Running" : "Run forecast"}
              </button>
            </div>

            <div className="status">
              <div className="status-row">
                <span>Progress</span>
                <strong>{progress.done}/{progress.total || 0}</strong>
              </div>
              <Progress.Root className="progress-root" value={progressPercent} max={100}>
                <Progress.Indicator className="progress-indicator" style={{ transform: `scaleX(${progressPercent / 100})` }} />
              </Progress.Root>
            </div>

            <p className="hint">Each slot fetches optimistic, best guess, and pessimistic estimates in both directions. The key is used in your browser.</p>
            {error ? <div className="error">{error}</div> : null}
          </section>

          <section className="panel results">
            <div className="results-head">
              <h2 className="results-title">Route timing</h2>
              <div className="results-actions">
                <button className="button secondary" onClick={copyTsv} disabled={!rows.length}>
                  <Clipboard size={16} aria-hidden="true" />
                  Copy TSV
                </button>
                <button className="button secondary" onClick={() => downloadText("traffic.tsv", tsv)} disabled={!rows.length}>
                  <Download size={16} aria-hidden="true" />
                  Download
                </button>
              </div>
            </div>

            {rows.length ? (
              <LineChart rows={rows} origin={origin} destination={destination} />
            ) : (
              <div className="empty">Run a forecast to visualize travel times in both directions.</div>
            )}
          </section>
        </div>
      </main>

      {toast ? (
        <Toast.Root className="toast-root" open={Boolean(toast)} onOpenChange={(open) => !open && setToast(null)}>
          <Toast.Title className="toast-title">{toast.title}</Toast.Title>
          <Toast.Description className="toast-description">{toast.description}</Toast.Description>
        </Toast.Root>
      ) : null}
      <Toast.Viewport className="toast-viewport" />
    </Toast.Provider>
  );
}

function LineChart({ rows, origin, destination }: { rows: ResultRow[]; origin: string; destination: string }) {
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    mode: "horizontal" | "vertical";
    datetime: string;
    route: string;
    range: RouteRange;
  } | null>(null);

  const chart = useMemo(() => {
    const values = numericValues(rows);
    const min = Math.max(0, Math.floor((Math.min(...values) - 5) / 5) * 5);
    const max = Math.ceil((Math.max(...values) + 5) / 5) * 5;
    const width = 920;
    const height = 480;
    const pad = { top: 26, right: 28, bottom: 78, left: 56 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const span = Math.max(1, max - min);

    function x(index: number) {
      return pad.left + (rows.length === 1 ? 0 : (index / (rows.length - 1)) * plotWidth);
    }

    function y(value: number) {
      return pad.top + (1 - (value - min) / span) * plotHeight;
    }

    function bestPathFor(key: "toDestination" | "toOrigin") {
      return rows
        .map((row, index) => {
          const value = row[key]?.bestGuess;
          if (typeof value !== "number") return "";
          return `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
        })
        .filter(Boolean)
        .join(" ");
    }

    function bandPathFor(key: "toDestination" | "toOrigin") {
      const upper = rows
        .map((row, index) => {
          const value = row[key]?.pessimistic;
          if (typeof value !== "number") return "";
          return `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
        })
        .filter(Boolean);
      const lower = rows
        .map((row, index) => {
          const value = row[key]?.optimistic;
          if (typeof value !== "number") return "";
          return `L ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
        })
        .filter(Boolean)
        .reverse();
      if (!upper.length || !lower.length) return "";
      return `${upper.join(" ")} ${lower.join(" ")} Z`;
    }

    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const value = min + (span / 4) * index;
      return {
        value: Math.round(value),
        y: y(value),
      };
    });

    const maxTicks = Math.min(9, rows.length);
    const tickIndexes = Array.from(
      new Set(
        Array.from({ length: maxTicks }, (_, index) =>
          Math.round(index * ((rows.length - 1) / Math.max(1, maxTicks - 1)))
        )
      )
    );

    return {
      width,
      height,
      pad,
      plotWidth,
      plotHeight,
      min,
      max,
      gridLines,
      tickIndexes,
      toDestinationBand: bandPathFor("toDestination"),
      toOriginBand: bandPathFor("toOrigin"),
      toDestinationPath: bestPathFor("toDestination"),
      toOriginPath: bestPathFor("toOrigin"),
      toDestinationMin: Math.min(...rows.map((row) => Number(row.toDestination?.optimistic)).filter(Number.isFinite)),
      toDestinationMax: Math.max(...rows.map((row) => Number(row.toDestination?.pessimistic)).filter(Number.isFinite)),
      toOriginMin: Math.min(...rows.map((row) => Number(row.toOrigin?.optimistic)).filter(Number.isFinite)),
      toOriginMax: Math.max(...rows.map((row) => Number(row.toOrigin?.pessimistic)).filter(Number.isFinite)),
      points: rows.flatMap((row, index) => {
        const pointX = x(index);
        const points: Array<{
          key: string;
          x: number;
          y: number;
          route: "destination" | "origin";
          label: string;
          datetime: string;
          range: RouteRange;
        }> = [];
        if (row.toDestination) {
          points.push({
            key: `${row.datetime}-destination`,
            x: pointX,
            y: y(row.toDestination.bestGuess),
            route: "destination",
            label: `${origin || "Origin"} to ${destination || "Destination"}`,
            datetime: row.datetime,
            range: row.toDestination,
          });
        }
        if (row.toOrigin) {
          points.push({
            key: `${row.datetime}-origin`,
            x: pointX,
            y: y(row.toOrigin.bestGuess),
            route: "origin",
            label: `${destination || "Destination"} to ${origin || "Origin"}`,
            datetime: row.datetime,
            range: row.toOrigin,
          });
        }
        return points;
      }),
    };
  }, [destination, origin, rows]);

  const verticalChart = useMemo(() => {
    const values = numericValues(rows);
    const min = Math.max(0, Math.floor((Math.min(...values) - 5) / 5) * 5);
    const max = Math.ceil((Math.max(...values) + 5) / 5) * 5;
    const width = 360;
    const rowGap = 34;
    const height = Math.max(520, 120 + (rows.length - 1) * rowGap);
    const pad = { top: 26, right: 18, bottom: 28, left: 78 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const span = Math.max(1, max - min);

    function x(value: number) {
      return pad.left + ((value - min) / span) * plotWidth;
    }

    function y(index: number) {
      return pad.top + (rows.length === 1 ? 0 : (index / (rows.length - 1)) * plotHeight);
    }

    function bestPathFor(key: "toDestination" | "toOrigin") {
      return rows
        .map((row, index) => {
          const value = row[key]?.bestGuess;
          if (typeof value !== "number") return "";
          return `${index === 0 ? "M" : "L"} ${x(value).toFixed(2)} ${y(index).toFixed(2)}`;
        })
        .filter(Boolean)
        .join(" ");
    }

    function bandPathFor(key: "toDestination" | "toOrigin") {
      const upper = rows
        .map((row, index) => {
          const value = row[key]?.pessimistic;
          if (typeof value !== "number") return "";
          return `${index === 0 ? "M" : "L"} ${x(value).toFixed(2)} ${y(index).toFixed(2)}`;
        })
        .filter(Boolean);
      const lower = rows
        .map((row, index) => {
          const value = row[key]?.optimistic;
          if (typeof value !== "number") return "";
          return `L ${x(value).toFixed(2)} ${y(index).toFixed(2)}`;
        })
        .filter(Boolean)
        .reverse();
      if (!upper.length || !lower.length) return "";
      return `${upper.join(" ")} ${lower.join(" ")} Z`;
    }

    const gridLines = Array.from({ length: 4 }, (_, index) => {
      const value = min + (span / 3) * index;
      return {
        value: Math.round(value),
        x: x(value),
      };
    });

    const maxTicks = Math.min(12, rows.length);
    const tickIndexes = Array.from(
      new Set(
        Array.from({ length: maxTicks }, (_, index) =>
          Math.round(index * ((rows.length - 1) / Math.max(1, maxTicks - 1)))
        )
      )
    );

    return {
      width,
      height,
      pad,
      plotWidth,
      plotHeight,
      gridLines,
      tickIndexes,
      toDestinationBand: bandPathFor("toDestination"),
      toOriginBand: bandPathFor("toOrigin"),
      toDestinationPath: bestPathFor("toDestination"),
      toOriginPath: bestPathFor("toOrigin"),
      points: rows.flatMap((row, index) => {
        const pointY = y(index);
        const points: Array<{
          key: string;
          x: number;
          y: number;
          route: "destination" | "origin";
          label: string;
          datetime: string;
          range: RouteRange;
        }> = [];
        if (row.toDestination) {
          points.push({
            key: `${row.datetime}-destination-mobile`,
            x: x(row.toDestination.bestGuess),
            y: pointY,
            route: "destination",
            label: `${origin || "Origin"} to ${destination || "Destination"}`,
            datetime: row.datetime,
            range: row.toDestination,
          });
        }
        if (row.toOrigin) {
          points.push({
            key: `${row.datetime}-origin-mobile`,
            x: x(row.toOrigin.bestGuess),
            y: pointY,
            route: "origin",
            label: `${destination || "Destination"} to ${origin || "Origin"}`,
            datetime: row.datetime,
            range: row.toOrigin,
          });
        }
        return points;
      }),
    };
  }, [destination, origin, rows]);

  return (
    <div className="chart-shell">
      <div className="chart-summary">
        <div className="summary-item destination">
          <span className="legend-dot" />
          <span>{origin} to {destination}</span>
          <strong>{chart.toDestinationMin}–{chart.toDestinationMax} min</strong>
        </div>
        <div className="summary-item origin">
          <span className="legend-dot" />
          <span>{destination} to {origin}</span>
          <strong>{chart.toOriginMin}–{chart.toOriginMax} min</strong>
        </div>
      </div>

      <div className="chart-scroll horizontal-chart">
        <svg className="line-chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Line chart comparing travel time in both directions">
          <rect x="0" y="0" width={chart.width} height={chart.height} rx="8" className="chart-bg" />
          {chart.gridLines.map((line) => (
            <g key={line.value}>
              <line x1={chart.pad.left} x2={chart.pad.left + chart.plotWidth} y1={line.y} y2={line.y} className="grid-line" />
              <text x={chart.pad.left - 10} y={line.y + 4} textAnchor="end" className="axis-label">{line.value}</text>
            </g>
          ))}
          <line x1={chart.pad.left} x2={chart.pad.left} y1={chart.pad.top} y2={chart.pad.top + chart.plotHeight} className="axis-line" />
          <line x1={chart.pad.left} x2={chart.pad.left + chart.plotWidth} y1={chart.pad.top + chart.plotHeight} y2={chart.pad.top + chart.plotHeight} className="axis-line" />
          <text x={18} y={chart.pad.top + 10} className="axis-title">min</text>
          {chart.tickIndexes.map((index) => {
            const x = chart.pad.left + (rows.length === 1 ? 0 : (index / (rows.length - 1)) * chart.plotWidth);
            const label = axisTickLabel(rows[index]?.datetime ?? "");
            return (
              <g key={index}>
                <line x1={x} x2={x} y1={chart.pad.top + chart.plotHeight} y2={chart.pad.top + chart.plotHeight + 6} className="tick-line" />
                <text x={x} y={chart.height - 42} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"} className="axis-label axis-time">
                  {label.time}
                </text>
                <text x={x} y={chart.height - 24} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"} className="axis-label axis-day">
                  {label.day}
                </text>
              </g>
            );
          })}
          <path d={chart.toDestinationBand} className="route-band destination-band" />
          <path d={chart.toOriginBand} className="route-band origin-band" />
          <path d={chart.toDestinationPath} className="route-line destination-line" />
          <path d={chart.toOriginPath} className="route-line origin-line" />
          {chart.points.map((point) => (
            <circle
              key={point.key}
              cx={point.x}
              cy={point.y}
              r="5"
              className={`route-point ${point.route}-point`}
              tabIndex={0}
              role="img"
              aria-label={`${point.datetime}, ${point.label}, ${formatRouteRange(point.range)}`}
              onMouseEnter={() => setHover({ x: point.x, y: point.y, mode: "horizontal", datetime: point.datetime, route: point.label, range: point.range })}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover({ x: point.x, y: point.y, mode: "horizontal", datetime: point.datetime, route: point.label, range: point.range })}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
        {hover?.mode === "horizontal" ? (
          <div
            className="chart-tooltip"
            style={{
              left: `${Math.min(86, Math.max(14, (hover.x / chart.width) * 100))}%`,
              top: `${Math.max(12, hover.y - 40)}px`,
            }}
          >
            <strong>{hover.datetime}</strong>
            <span>{hover.route}</span>
            <span>{formatRouteRange(hover.range)}</span>
          </div>
        ) : null}
      </div>
      <div className="chart-scroll vertical-chart">
        <svg className="line-chart vertical-line-chart" viewBox={`0 0 ${verticalChart.width} ${verticalChart.height}`} role="img" aria-label="Vertical line chart comparing travel time in both directions">
          <rect x="0" y="0" width={verticalChart.width} height={verticalChart.height} rx="8" className="chart-bg" />
          {verticalChart.gridLines.map((line) => (
            <g key={line.value}>
              <line x1={line.x} x2={line.x} y1={verticalChart.pad.top} y2={verticalChart.pad.top + verticalChart.plotHeight} className="grid-line" />
              <text x={line.x} y={18} textAnchor="middle" className="axis-label axis-time">{line.value}</text>
            </g>
          ))}
          <text x={verticalChart.pad.left} y={18} textAnchor="end" className="axis-title">min</text>
          <line x1={verticalChart.pad.left} x2={verticalChart.pad.left + verticalChart.plotWidth} y1={verticalChart.pad.top} y2={verticalChart.pad.top} className="axis-line" />
          <line x1={verticalChart.pad.left} x2={verticalChart.pad.left} y1={verticalChart.pad.top} y2={verticalChart.pad.top + verticalChart.plotHeight} className="axis-line" />
          {verticalChart.tickIndexes.map((index) => {
            const y = verticalChart.pad.top + (rows.length === 1 ? 0 : (index / (rows.length - 1)) * verticalChart.plotHeight);
            const label = axisTickLabel(rows[index]?.datetime ?? "");
            return (
              <g key={index}>
                <line x1={verticalChart.pad.left - 6} x2={verticalChart.pad.left} y1={y} y2={y} className="tick-line" />
                <text x={verticalChart.pad.left - 10} y={y - 2} textAnchor="end" className="axis-label axis-time">
                  {label.time}
                </text>
                <text x={verticalChart.pad.left - 10} y={y + 13} textAnchor="end" className="axis-label axis-day">
                  {label.day}
                </text>
              </g>
            );
          })}
          <path d={verticalChart.toDestinationBand} className="route-band destination-band" />
          <path d={verticalChart.toOriginBand} className="route-band origin-band" />
          <path d={verticalChart.toDestinationPath} className="route-line destination-line" />
          <path d={verticalChart.toOriginPath} className="route-line origin-line" />
          {verticalChart.points.map((point) => (
            <circle
              key={point.key}
              cx={point.x}
              cy={point.y}
              r="5"
              className={`route-point ${point.route}-point`}
              tabIndex={0}
              role="img"
              aria-label={`${point.datetime}, ${point.label}, ${formatRouteRange(point.range)}`}
              onMouseEnter={() => setHover({ x: point.x, y: point.y, mode: "vertical", datetime: point.datetime, route: point.label, range: point.range })}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover({ x: point.x, y: point.y, mode: "vertical", datetime: point.datetime, route: point.label, range: point.range })}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
        {hover?.mode === "vertical" ? (
          <div
            className="chart-tooltip vertical-tooltip"
            style={{
              left: `${Math.min(82, Math.max(26, (hover.x / verticalChart.width) * 100))}%`,
              top: `${Math.max(12, hover.y - 40)}px`,
            }}
          >
            <strong>{hover.datetime}</strong>
            <span>{hover.route}</span>
            <span>{formatRouteRange(hover.range)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className="field">
      <Label.Root className="label" htmlFor={id}>{label}</Label.Root>
      {React.cloneElement(children, { id })}
    </div>
  );
}

function RadixSelect({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="select-trigger">
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={16} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={5}>
          <Select.Viewport>{children}</Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

async function fetchDurationRange({
  key,
  origin,
  destination,
  departureTime,
}: {
  key: string;
  origin: string;
  destination: string;
  departureTime: string;
}): Promise<RouteRange> {
  const [optimistic, bestGuess, pessimistic] = await Promise.all([
    fetchDuration({ key, origin, destination, departureTime, trafficModel: "OPTIMISTIC" }),
    fetchDuration({ key, origin, destination, departureTime, trafficModel: "BEST_GUESS" }),
    fetchDuration({ key, origin, destination, departureTime, trafficModel: "PESSIMISTIC" }),
  ]);
  return { optimistic, bestGuess, pessimistic };
}

async function fetchDuration({
  key,
  origin,
  destination,
  departureTime,
  trafficModel,
}: {
  key: string;
  origin: string;
  destination: string;
  departureTime: string;
  trafficModel: TrafficModel;
}) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration",
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
      trafficModel,
      departureTime,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Routes API returned HTTP ${response.status}.`);
  }

  const duration = data?.routes?.[0]?.duration;
  if (!duration) {
    throw new Error("Routes API did not return a route duration.");
  }

  return secondsToMinutes(duration);
}

createRoot(document.getElementById("root")!).render(<App />);
