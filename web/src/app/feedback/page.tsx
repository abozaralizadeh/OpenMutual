import { ActionForm } from '@/components/ActionForm';
import { sendFeedback } from '@/lib/actions';

export default function Feedback() {
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h1>Feedback</h1>
      <p className="muted">What confused you? What did you expect to happen? Please leave out anything personal.</p>
      <ActionForm action={sendFeedback} submit="Send">
        <label>
          How clear was it?
          <select name="rating" defaultValue="">
            <option value="">No answer</option>
            <option value="5">Very clear</option>
            <option value="4">Mostly clear</option>
            <option value="3">So so</option>
            <option value="2">Confusing</option>
            <option value="1">Very confusing</option>
          </select>
        </label>
        <label>Your thoughts<textarea name="text" rows={5} required maxLength={2000} /></label>
      </ActionForm>
    </div>
  );
}
