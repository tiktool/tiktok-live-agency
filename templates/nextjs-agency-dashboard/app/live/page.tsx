import { LiveBoard } from './LiveBoard';

export default function LivePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Live now</h1>
      <p className="text-sm muted">Refreshes every 60 seconds. A failed check shows as Unknown, never as Offline.</p>
      <LiveBoard />
    </div>
  );
}
