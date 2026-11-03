interface Point {
  time: number;
  price: number;
}

/** Share price over time. One line, so it needs no legend. */
export function LineChart({ points }: { points: Point[] }) {
  if (points.length < 2) return <p className="muted">The chart starts once the clock has moved on a little.</p>;
  const width = 640;
  const height = 200;
  const pad = 8;
  const times = points.map((point) => point.time);
  const prices = points.map((point) => point.price);
  const [minTime, maxTime] = [Math.min(...times), Math.max(...times)];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const room = Math.max((high - low) * 0.15, 0.0005);
  const [minPrice, maxPrice] = [low - room, high + room];
  const x = (time: number) => pad + ((time - minTime) / Math.max(maxTime - minTime, 1)) * (width - pad * 2);
  const y = (price: number) => height - pad - ((price - minPrice) / (maxPrice - minPrice)) * (height - pad * 2);
  // Drawn as steps: the price only moves when a cover ends, never in between.
  const line = points
    .flatMap((point, index) => {
      const here = `${x(point.time).toFixed(1)},${y(point.price).toFixed(1)}`;
      return index === 0 ? [here] : [`${x(point.time).toFixed(1)},${y(points[index - 1].price).toFixed(1)}`, here];
    })
    .join(' ');
  const last = points[points.length - 1];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Share price, from ${points[0].price.toFixed(4)} to ${last.price.toFixed(4)}`}>
        <line x1={pad} x2={width - pad} y1={y(1)} y2={y(1)} className="chart-base" />
        <polyline points={line} className="chart-line" />
        <circle cx={x(last.time)} cy={y(last.price)} r="4" className="chart-dot" />
      </svg>
      <figcaption className="muted">Dashed line is the starting price of 1. Latest: {last.price.toFixed(4)} tUSD a share.</figcaption>
    </figure>
  );
}
