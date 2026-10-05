import { api, chatgptSignInUrl } from '../api';
import { useApp } from '../context';

/** OpenAI's knot, drawn small for the sign-in button. */
function Knot() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M21.6 9.8a5.7 5.7 0 0 0-.5-4.7 5.8 5.8 0 0 0-6.2-2.8A5.8 5.8 0 0 0 5.1 4.4a5.7 5.7 0 0 0-3.8 2.8 5.8 5.8 0 0 0 .7 6.8 5.7 5.7 0 0 0 .5 4.7 5.8 5.8 0 0 0 6.2 2.8 5.7 5.7 0 0 0 4.3 1.9 5.8 5.8 0 0 0 5.5-4 5.7 5.7 0 0 0 3.8-2.8 5.8 5.8 0 0 0-.7-6.8Zm-8.6 12a4.3 4.3 0 0 1-2.8-1l.1-.1 4.6-2.7a.8.8 0 0 0 .4-.7v-6.5l2 1.1v5.4a4.3 4.3 0 0 1-4.3 4.3ZM3.6 17.8a4.3 4.3 0 0 1-.5-2.9l.1.1 4.6 2.7a.8.8 0 0 0 .8 0l5.6-3.3v2.3l-4.7 2.7a4.3 4.3 0 0 1-5.9-1.6ZM2.4 7.9a4.3 4.3 0 0 1 2.2-1.9v5.5a.8.8 0 0 0 .4.7l5.6 3.2-2 1.1-4.6-2.7a4.3 4.3 0 0 1-1.6-5.9Zm16 3.7-5.6-3.3 2-1.1 4.6 2.7a4.3 4.3 0 0 1-.7 7.7v-5.5a.8.8 0 0 0-.4-.7Zm1.9-2.9-.1-.1-4.6-2.7a.8.8 0 0 0-.8 0l-5.6 3.3V6.9l4.7-2.7a4.3 4.3 0 0 1 6.4 4.5ZM8 12.8l-2-1.1V6.2a4.3 4.3 0 0 1 7-3.3l-.1.1-4.6 2.7a.8.8 0 0 0-.4.7Zm1.1-2.3L12 8.8l2.5 1.5v2.9L12 14.7l-2.5-1.5Z" />
    </svg>
  );
}

/** The button that sends a student to ChatGPT to connect their plan, and back to this page. */
export function ChatGPTSignIn({ label = 'Sign in with ChatGPT', className = 'btn' }: { label?: string; className?: string }) {
  return (
    <a className={`${className} chatgpt-btn`} href={chatgptSignInUrl()}>
      <Knot /> {label}
    </a>
  );
}

/** Under the ask box: whose plan answers run on, and the way to change it. Nothing when the feature is off here. */
export function ChatGPTLine() {
  const { chatgpt, refreshChatGPT, toast } = useApp();
  if (!chatgpt?.available) return null;
  if (chatgpt.connected) {
    const disconnect = async () => {
      await api.chatgpt.logout().catch(() => {});
      refreshChatGPT();
      toast('ChatGPT disconnected');
    };
    return (
      <p className="chatgpt-line">
        <Knot /> Answering on your ChatGPT plan{chatgpt.email ? ` (${chatgpt.email})` : ''}.{' '}
        <button type="button" className="link-btn" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </p>
    );
  }
  return (
    <p className="chatgpt-line">
      {chatgpt.required ? 'Answers run on your own ChatGPT plan.' : 'Use your own ChatGPT plan for answers.'} <ChatGPTSignIn className="link-btn" label="Sign in with ChatGPT" />
    </p>
  );
}
