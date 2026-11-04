import Link from 'next/link';
import { bagOffer, chainNow, citiesList, dateOf, flightOffer, ladderOn, poolNumbers, rainOffer, upcomingFlights, type Offer } from '@openmutual/shared';
import { ActionForm } from '@/components/ActionForm';
import { buy } from '@/lib/actions';
import { clockTime, money, percent, shortDate } from '@/lib/format';
import { currentUser, syncedApp } from '@/lib/server';

type Search = Promise<{ product?: string; date?: string; subject?: string }>;
const DAY = 86_400;
const NO_ONE = '0x0000000000000000000000000000000000000000';

const RULES: Record<string, string> = {
  'flight-delay': 'Pays if the flight lands 3 hours or more late, or is cancelled. Sales close 24 hours before departure.',
  'rainy-day': 'Pays if 10 mm or more of rain falls in that city that day. Sales close 2 days before.',
  'lost-bag': 'You file a claim if your bag goes missing, and members vote on it. You have 7 days after the trip ends.',
};

const LADDER_BAG_RULE =
  'You file a claim if your bag goes missing. An AI panel answers first, and a jury of members if the panel doesn\'t agree or someone challenges it. You have 7 days after the trip ends.';

function dates(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => dateOf(start + index * DAY));
}

export default async function Cover({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const app = await syncedApp();
  const [now, numbers, user] = await Promise.all([chainNow(app.client), poolNumbers(app), currentUser()]);
  const product = app.decisions.products.find((item) => item.key === params.product) ?? app.decisions.products[0];
  const days = dates(now + (product.salesCutoffHours > 24 ? 3 : 2) * DAY, 14);
  const date = params.date && days.includes(params.date) ? params.date : days[0];
  const flights = product.key === 'flight-delay' ? await upcomingFlights(app, date) : [];

  const priced = (offer: Offer) => ({ offer, price: app.pricing.price({ productKey: offer.productKey, payout: offer.payout, route: offer.route }) });
  let chosen: ReturnType<typeof priced> | null = null;
  try {
    if (product.key === 'flight-delay' && params.subject) chosen = priced(flightOffer(app, params.subject, date));
    if (product.key === 'rainy-day' && params.subject) chosen = priced(rainOffer(app, params.subject, date));
    if (product.key === 'lost-bag' && params.subject) chosen = priced(bagOffer(app, NO_ONE, date));
  } catch {
    chosen = null;
  }

  return (
    <>
      <h1>Get test cover</h1>
      <p className="lead">Pick something to cover. It&apos;s all made up and paid for with test money.</p>
      <nav className="tabs" aria-label="Products">
        {app.decisions.products.map((item) => (
          <Link key={item.key} href={`/cover?product=${item.key}`} aria-current={item.key === product.key ? 'page' : undefined}>
            {item.name}
          </Link>
        ))}
      </nav>
      <p>{product.key === 'lost-bag' && ladderOn(app) ? LADDER_BAG_RULE : RULES[product.key]}</p>
      {product.wording ? <p className="small muted" data-testid="wording">What it pays for: {product.wording}</p> : null}
      {numbers.paused ? <p className="callout warn">New covers are paused right now.</p> : null}

      <form method="get" action="/cover" className="row" style={{ marginBottom: 20, alignItems: 'flex-end' }}>
        <input type="hidden" name="product" value={product.key} />
        <label>
          {product.key === 'lost-bag' ? 'Trip ends on' : 'Date'}
          <select name="date" defaultValue={date}>
            {days.map((day) => (
              <option key={day} value={day}>{shortDate(Date.parse(`${day}T12:00:00Z`) / 1000)}</option>
            ))}
          </select>
        </label>
        {product.key === 'rainy-day' ? (
          <label>
            City
            <select name="subject" defaultValue={params.subject ?? citiesList()[0]}>
              {citiesList().map((city) => <option key={city}>{city}</option>)}
            </select>
          </label>
        ) : null}
        {product.key === 'lost-bag' ? <input type="hidden" name="subject" value="trip" /> : null}
        <button className="button quiet">{product.key === 'flight-delay' ? 'Show flights' : 'See the price'}</button>
      </form>

      {chosen ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2>{product.key === 'lost-bag' ? `Bag on a trip ending ${date}` : chosen.offer.label}</h2>
          <div className="stats" style={{ marginBottom: 14 }}>
            <div className="stat"><span>Price</span><strong data-testid="price">{money(chosen.price.premium)}</strong></div>
            <div className="stat"><span>Payout</span><strong>{money(chosen.offer.payout)}</strong></div>
            <div className="stat"><span>Priced at a chance of</span><strong>{percent(chosen.price.chance)}</strong></div>
          </div>
          {user ? (
            <ActionForm action={buy} submit={`Buy for ${money(chosen.price.premium)}`}>
              <input type="hidden" name="product" value={product.key} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="subject" value={params.subject} />
            </ActionForm>
          ) : (
            <Link href="/login" className="button">Sign in to buy</Link>
          )}
        </div>
      ) : null}

      {product.key === 'flight-delay' ? (
        flights.length === 0 ? (
          <p className="muted">No flights left on sale that day. Try a later date.</p>
        ) : (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr><th>Flight</th><th>Route</th><th>Leaves</th><th>Lands</th><th className="num">Price</th><th><span className="sr-only">Choose</span></th></tr>
              </thead>
              <tbody>
                {flights.map((flight) => {
                  const { price } = priced(flightOffer(app, flight.number, date));
                  return (
                    <tr key={flight.number}>
                      <td>{flight.number}</td>
                      <td>{flight.from} to {flight.to}</td>
                      <td>{clockTime(flight.departure)}</td>
                      <td>{clockTime(flight.arrival)}</td>
                      <td className="num">{money(price.premium)}</td>
                      <td><Link href={`/cover?product=flight-delay&date=${date}&subject=${flight.number}`}>Choose {flight.number}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </>
  );
}
