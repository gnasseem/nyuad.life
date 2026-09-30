import { APP_NAME, APP_TAGLINE } from '../brand';
import { IconAsk, IconMegaphone, IconQuestions } from '../icons';
import { Mark } from './Logo';
import { Modal } from './Modal';
import { ProfileForm } from './ProfileForm';

interface Props {
  open: boolean;
  /** Called whether a profile was saved or the sheet was skipped; the caller records that the welcome was shown. */
  onDone(saved: boolean): void;
}

/** The first thing a new visitor sees: what the site is in three lines, then who they are in four fields. */
export function Welcome({ open, onDone }: Props) {
  return (
    <Modal open={open} onClose={() => onDone(false)} width={560} eyebrow={<Mark className="welcome-mark" />} title={`Welcome to ${APP_NAME}`} subtitle={APP_TAGLINE}>
      <div className="features">
        <div className="feature">
          <span className="ic">
            <IconAsk />
          </span>
          <div>
            <b>Ask anything about NYUAD</b>
            <span>Answers come from thousands of Room of Requirement threads, with the sources cited so you can check.</span>
          </div>
        </div>
        <div className="feature">
          <span className="ic">
            <IconQuestions />
          </span>
          <div>
            <b>Ask students when the archive falls short</b>
            <span>Questions go to the majors and years best placed to answer, one card at a time.</span>
          </div>
        </div>
        <div className="feature">
          <span className="ic">
            <IconMegaphone />
          </span>
          <div>
            <b>What’s on, Falcons and the guide</b>
            <span>Events and deadlines this week, Falcons traded between students, and the official pages summarised next to what students said.</span>
          </div>
        </div>
      </div>
      <div className="divider">Tell us who you are</div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Your major and year route the right questions to you, and your name goes next to what you write. One time only, and you can change it in Settings.
      </p>
      <ProfileForm submitLabel="Let's go" onDone={() => onDone(true)} onSkip={() => onDone(false)} />
    </Modal>
  );
}
