# Answering OMP questions

Interactive requests appear in an **OMP needs your answer** card below the Agent Inspector and above the main conversation. The card belongs to the active chat. Collapsing the inspector or the selected worker/advisor transcript does not hide it.

Use the card's answer controls. The ordinary composer sends or queues a chat message; it does not submit an interactive dialog response.

## Supported requests

- Structured questions: single or multiple selections, descriptions/previews, recommended labels, and a custom text answer. Every question needs an answer before **Submit answers** becomes available. A recommended option is not automatically submitted.
- Choice requests: select one of the supplied options or cancel.
- Confirmations and tool approvals: answer **Yes** or **No**, when OMP's configured policy requests approval.
- Text and editor requests: enter a short or multiline answer, then submit or cancel.

Multiple requests are queued per OMP session. Answering the current card reveals the next pending request. Answers are returned to their matching request ID. OMP cancellation and timeouts remove the corresponding card. If the connected process exits, its pending cards and timers are cleared; the connection error remains visible.

## Which agents can ask?

The main RPC session's interactive requests use this card. Main-session advisor tools can also use that session's dialog/approval runner when their configuration requires it. Default advisors normally produce advice with their configured read tools.

OMP 18.4.10 runs workers headlessly; worker questions are not generally forwarded into operator forms. Advisors owned by a worker inherit that headless context. The extension follows OMP's runtime behavior rather than creating a separate answer channel for those agents.

An ordinary sentence asking a question remains in the transcript. It does not automatically become a form. Reply through the main composer, or use **Send direction** for a running worker when appropriate.

## Other chat tabs

A pending question in another chat is shown when you select that tab. There is currently no dedicated waiting-for-answer badge for background tabs. OMP timeouts still apply while a tab is inactive.

## Verification

Host and webview tests cover structured answers, option labels, custom input, validation, cancellation and draft preservation. Lifecycle tests cover process exit, timer cleanup and stale-client isolation. Earlier live OMP checks also accepted a structured answer and an explicit tool approval. See [verification](verification.md) for the tested runtime and remaining desktop verification limits.
