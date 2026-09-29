import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";

const GUIDE_STEPS: string[] = [
  "In the Shortcuts app, tap + to create a new shortcut and add a “Text” action — this holds what you say or type, e.g. “coffee 12”.",
  "Add “Get Contents of URL”: set the URL to the quick-entry endpoint below, method POST, a Request Header “Authorization” with value “Bearer ” followed by your token, and a JSON request body with a “text” field set to the Text action’s output.",
  "Add “Show Notification” and set its body to the “message” field from the response — that’s your 5-second confirmation.",
  "Add an “If” action so a failed request falls back to “Open URL” pointing at the quick-entry page with your text — nothing gets dropped.",
];

/**
 * The iOS Shortcut setup guide — four actions in the Shortcuts app, plus the
 * request/response shape. Extracted from Settings › Shortcut (Task 7) so the
 * Task 15 onboarding wizard's Shortcut step can show the identical guide;
 * `appUrl` is the caller's resolved origin (host + protocol).
 */
export function ShortcutGuide({ appUrl }: { appUrl: string }) {
  return (
    <Card title="iOS Shortcut setup">
      <Tip className="mb-3">Four actions in the Shortcuts app — about two minutes.</Tip>
      <ol className="mb-3 flex list-decimal flex-col gap-2 pl-5">
        {GUIDE_STEPS.map((step, i) => (
          <li key={i}>
            <Tip>{step}</Tip>
          </li>
        ))}
      </ol>
      <pre
        className="overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed"
        style={{
          background: "var(--page)",
          border: "1px solid var(--border)",
          color: "var(--ink-2)",
        }}
      >
        {`Text                  -> your entry, e.g. "coffee 12"
Get Contents of URL   -> POST ${appUrl}/api/quick-entry
  Header: Authorization: Bearer <token>
  Body:   JSON {"text": ShortcutInput}
Show Notification     -> "message" from the response
If  Get Contents of URL failed
  Open URL            -> ${appUrl}/quick?text=ShortcutInput`}
      </pre>
    </Card>
  );
}
