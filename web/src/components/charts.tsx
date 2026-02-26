import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import dayjs from "dayjs";
import { Doughnut, Line } from "react-chartjs-2";
import type { HeatmapCell, LineChartEntry, MasteryDistribution } from "../types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
);

interface MemoryLineChartProps {
  data: LineChartEntry[];
  showLegend?: boolean;
  height?: number;
}

export function MemoryLineChart({ data, showLegend = true, height = 220 }: MemoryLineChartProps) {
  const labels = data.map((item) => dayjs(item.date).format("M/D"));

  return (
    <div style={{ height }}>
      <Line
        data={{
          labels,
          datasets: [
            {
              label: "新词",
              data: data.map((item) => item.newCount),
              borderColor: "#2E5CCB",
              backgroundColor: "rgba(46,92,203,0.16)",
              tension: 0.35,
              borderWidth: 3,
              pointRadius: data.length <= 14 ? 2.8 : 0,
              pointHoverRadius: data.length <= 14 ? 3.2 : 0,
              pointBorderWidth: 0,
            },
            {
              label: "复习",
              data: data.map((item) => item.reviewCount),
              borderColor: "#4AA978",
              backgroundColor: "rgba(74,169,120,0.12)",
              tension: 0.35,
              borderWidth: 3,
              pointRadius: data.length <= 14 ? 2.8 : 0,
              pointHoverRadius: data.length <= 14 ? 3.2 : 0,
              pointBorderWidth: 0,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: showLegend,
              labels: {
                color: "#6d7895",
                boxWidth: 18,
                boxHeight: 8,
                padding: 10,
                font: {
                  size: 11,
                },
              },
            },
            tooltip: {
              mode: "index",
              intersect: false,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: {
                color: "rgba(186,198,227,0.48)",
              },
              ticks: {
                precision: 0,
                color: "#6d7895",
                font: {
                  size: 11,
                },
              },
            },
            x: {
              grid: {
                color: "rgba(186,198,227,0.36)",
              },
              ticks: {
                color: "#6d7895",
                display: data.length <= 14,
                autoSkip: true,
                maxTicksLimit: data.length > 14 ? 8 : 7,
                maxRotation: 0,
                minRotation: 0,
                font: {
                  size: 11,
                },
              },
            },
          },
        }}
      />
    </div>
  );
}

interface MasteryDonutChartProps {
  mastery: MasteryDistribution;
  height?: number;
}

export function MasteryDonutChart({ mastery, height = 220 }: MasteryDonutChartProps) {
  const percent = mastery.total > 0 ? Math.round((mastery.mastered * 100) / mastery.total) : 0;

  return (
    <div style={{ height, position: "relative" }}>
      <Doughnut
        data={{
          labels: ["未学", "学习中", "已掌握"],
          datasets: [
            {
              data: [mastery.unlearned, mastery.learning, mastery.mastered],
              backgroundColor: ["#DDE5F7", "#E0AB42", "#4AA978"],
              borderWidth: 0,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          cutout: "62%",
          plugins: {
            legend: {
              display: false,
            },
          },
        }}
      />
      <div className="donut-center-text">
        <div>已掌握</div>
        <strong>{percent}%</strong>
      </div>
    </div>
  );
}

export function MasteryLegend() {
  return (
    <div className="legend-row">
      <LegendItem color="#DDE5F7" label="未学" />
      <LegendItem color="#E0AB42" label="学习中" />
      <LegendItem color="#4AA978" label="已掌握" />
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="legend-item">
      <span className="legend-dot" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </div>
  );
}

export function HeatmapGrid({ cells }: { cells: HeatmapCell[] }) {
  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  const dayLabels = ["一", "二", "三", "四", "五", "六", "日"];

  return (
    <div className="heatmap-grid">
      {dayLabels.map((label, dayIndex) => (
        <div key={label} className="heatmap-row">
          <span className="heatmap-day-label">{label}</span>
          <div className="heatmap-week-row">
            {weeks.map((week, index) => {
              const cell = week[dayIndex];
              return <span key={`${label}-${index}`} className="heatmap-cell" style={{ backgroundColor: cellColor(cell) }} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function cellColor(cell: HeatmapCell | undefined): string {
  if (!cell) return "transparent";
  const colors = ["rgba(46,92,203,0.1)", "rgba(46,92,203,0.22)", "rgba(46,92,203,0.38)", "rgba(46,92,203,0.56)", "rgba(46,92,203,0.8)"];
  const base = colors[Math.max(0, Math.min(colors.length - 1, cell.level))];
  if (!cell.inRange) {
    return "rgba(186,198,227,0.16)";
  }
  return base;
}

export function HeatmapLegend() {
  return (
    <div className="legend-row">
      <span>少</span>
      <span className="legend-dot" style={{ backgroundColor: "rgba(46,92,203,0.2)" }} />
      <span className="legend-dot" style={{ backgroundColor: "rgba(46,92,203,0.4)" }} />
      <span className="legend-dot" style={{ backgroundColor: "rgba(46,92,203,0.6)" }} />
      <span className="legend-dot" style={{ backgroundColor: "rgba(46,92,203,0.8)" }} />
      <span>多</span>
    </div>
  );
}

export function MemoryStabilityCard({
  stabilityIndex,
  confidence,
  optimalHourStart,
  optimalHourEnd,
  sampleCount,
}: {
  stabilityIndex: number;
  confidence: number;
  optimalHourStart: number;
  optimalHourEnd: number;
  sampleCount: number;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, stabilityIndex)) * 100);
  const confidencePercent = Math.round(Math.max(0, Math.min(1, confidence)) * 100);

  return (
    <div className="card-block">
      <h3>记忆稳定性</h3>
      <div className="metric-row">
        <span>记忆保留率</span>
        <strong>{percent}%</strong>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="metrics-inline">
        <div>
          <small>模型置信度</small>
          <strong>{confidencePercent}%</strong>
        </div>
        <div>
          <small>训练样本</small>
          <strong>{sampleCount}</strong>
        </div>
      </div>
      <p className="muted">最佳学习时段：{String(optimalHourStart).padStart(2, "0")}:00 - {String(optimalHourEnd).padStart(2, "0")}:00</p>
      {sampleCount < 50 && <p className="muted">继续学习以提升预测准确度（{sampleCount}/50）</p>}
    </div>
  );
}

export interface MemoryHeatmapEntry {
  dayOfWeek: number;
  hour: number;
  efficiency: number;
}

export function MemoryHeatmapCard({ data }: { data: MemoryHeatmapEntry[] }) {
  const dayLabels = ["一", "二", "三", "四", "五", "六", "日"];
  return (
    <div className="card-block">
      <h3>记忆效率热力图</h3>
      <p className="muted">展示不同时段的学习效率</p>
      <div className="ml-heatmap-table">
        <div className="ml-hour-head">
          {Array.from({ length: 24 }, (_, index) => (
            <span key={index}>{index % 4 === 0 ? index : ""}</span>
          ))}
        </div>
        {dayLabels.map((label, day) => (
          <div key={label} className="ml-heatmap-row">
            <span className="ml-day-label">{label}</span>
            <div className="ml-cells">
              {Array.from({ length: 24 }, (_, hour) => {
                const entry = data.find((item) => item.dayOfWeek === day && item.hour === hour);
                const value = entry?.efficiency ?? 0;
                return <span key={`${day}-${hour}`} className="ml-cell" style={{ backgroundColor: mlColor(value) }} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="legend-row">
        <span>低效</span>
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className="legend-dot" style={{ backgroundColor: mlColor(index / 4) }} />
        ))}
        <span>高效</span>
      </div>
    </div>
  );
}

function mlColor(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(255 - clamped * 110);
  const green = Math.round(221 - clamped * 40);
  const blue = Math.round(221 - clamped * 130);
  return `rgba(${red}, ${green}, ${blue}, 0.9)`;
}
