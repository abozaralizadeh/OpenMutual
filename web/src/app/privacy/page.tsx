export default function Privacy() {
  return (
    <div className="card" style={{ maxWidth: 680 }}>
      <h1>Privacy</h1>
      <p className="muted small">Draft for a closed test. A lawyer hasn&apos;t reviewed this yet.</p>
      <h2>What&apos;s kept</h2>
      <ul className="steps">
        <li>A one way scrambled version of your email, used to find your account. The email itself isn&apos;t stored.</li>
        <li>A test wallet made for you, and what it does on the local test chain.</li>
        <li>Anything you type in a claim, a proposal or the feedback form. Claims and proposals are shown to other users.</li>
        <li>Daily totals of how often things happen, such as covers bought. These aren&apos;t linked to anyone.</li>
        <li>A cookie that keeps you signed in. There are no tracking cookies.</li>
      </ul>
      <h2>What isn&apos;t kept</h2>
      <p>Names and countries typed in the membership check are scrambled straight away, and only the scrambled version is kept. No names or emails go on the chain.</p>
      <h2>Getting rid of it</h2>
      <p>All data is wiped when the simulation is reset. There are no outside services, so nothing is sent anywhere.</p>
    </div>
  );
}
