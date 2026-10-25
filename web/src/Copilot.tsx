import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, ArrowUp, RotateCcw } from "lucide-react";
import { localReply, validateReply, type CopilotContext, type CopilotReply, type Destination } from "../../src/copilot";

interface Message { id: number; role: "user" | "assistant"; content: string; reply?: CopilotReply; used?: boolean; }
const welcome: Message = { id: 0, role: "assistant", content: "Hi, I’m your Nexus copilot. I can help you plan a payment, understand a blocked task, or find your way around. What would you like to do?" };
const pageNames: Record<Destination, string> = { overview: "Overview", copilot: "Agent tasks", policy: "Spending rules", attacks: "Security lab", anomaly: "Anomaly shield", recovery: "Recovery", fuzzer: "Verification", contracts: "Contracts" };

export default function Copilot({ context, aiAvailable, onNavigate, onPlan }: {
  context: CopilotContext;
  aiAvailable: boolean;
  onNavigate: (destination: Destination) => void;
  onPlan: (amount: string, recipient: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [input, setInput] = useState("");
  const [aiMode, setAiMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [retry, setRetry] = useState("");
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const createdPlans = useRef(new Set<number>());
  const scrollEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { if (open) scrollEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages, busy, open]);
  const close = () => { setOpen(false); launcher.current?.focus(); };
  const cancel = () => {
    generation.current++; controller.current?.abort(); controller.current = null;
    setBusy(false);
  };
  const send = async (text: string, isRetry = false) => {
    if (!text.trim() || controller.current || text.length > 2000) return;
    const content = text.trim();
    const conversation = isRetry ? messages : [...messages, { id: ++sequence.current, role: "user" as const, content }];
    setMessages(conversation); setInput(""); setError(""); setRetry(content);
    if (!aiMode) {
      const response = localReply(content, context, draft);
      setDraft(response.draft ?? "");
      setMessages([...conversation, { id: ++sequence.current, role: "assistant", content: response.message, reply: response }]);
      setRetry(""); return;
    }
    const current = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 25000);
    setBusy(true);
    try {
      const response = await fetch("/api/copilot", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ messages: conversation.slice(-12).map(({ role, content }) => ({ role, content })), context }),
      });
      if (!response.headers.get("content-type")?.includes("json")) throw new Error("AI chat is unavailable on this preview. Switch to the built-in guide.");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not get an answer.");
      const answer = validateReply(body);
      if (current !== generation.current) return;
      setMessages(previous => [...previous, { id: ++sequence.current, role: "assistant", content: answer.message, reply: answer }]);
      setRetry(""); setDraft("");
    } catch (cause) {
      if (current === generation.current) setError(abort.signal.aborted ? "The request timed out. Retry or use the built-in guide." : cause instanceof Error ? cause.message : "Could not get an answer.");
    } finally {
      clearTimeout(timeout);
      if (current === generation.current) { controller.current = null; setBusy(false); inputRef.current?.focus(); }
    }
  };

  return <>
    <button ref={launcher} className="copilot-launcher" aria-expanded={open} aria-controls="nexus-copilot" onClick={() => setOpen(value => !value)}>
      <MessageCircle size={18}/><span>Ask Copilot</span>
    </button>
    {open && <section id="nexus-copilot" className="copilot-panel" role="dialog" aria-label="Nexus Copilot" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header className="copilot-heading"><div><h2>Nexus Copilot</h2><p>{aiMode ? "AI assistant" : "Built-in guide"} · here to help</p></div><div>
        <button title="Start new chat" aria-label="Start new chat" onClick={() => { cancel(); setMessages([welcome]); setError(""); setRetry(""); setDraft(""); setInput(""); inputRef.current?.focus(); }}><RotateCcw size={16}/></button>
        <button aria-label="Close copilot" onClick={close}><X size={19}/></button>
      </div></header>
      <div className="copilot-mode">{aiAvailable ? <label><input type="checkbox" checked={aiMode} disabled={busy} onChange={e => { setAiMode(e.target.checked); setError(""); setDraft(""); }}/> Use AI chat · sends recent messages and demo task context to OpenAI</label> : "AI isn’t configured yet. The built-in guide can still help with this workspace."}</div>
      <div className="copilot-messages" role="log" aria-label="Copilot conversation" aria-live="polite" aria-busy={busy}>
        {messages.map(message => <article className={"copilot-message " + message.role} key={message.id}>
          <span className="message-author">{message.role === "user" ? "You" : "Copilot"}</span><p>{message.content}</p>
          {message.reply?.destination && <button className="copilot-action" onClick={() => { onNavigate(message.reply!.destination!); close(); }}>Open {pageNames[message.reply.destination]} →</button>}
          {message.reply?.payment && <div className="copilot-payment"><span>{message.reply.payment.amount} ETH</span><small>{message.reply.payment.recipient}</small><button className="copilot-action" disabled={message.used} onClick={() => {
            if (message.used || createdPlans.current.has(message.id)) return;
            createdPlans.current.add(message.id);
            onPlan(message.reply!.payment!.amount, message.reply!.payment!.recipient);
            setMessages(previous => previous.map(item => item.id === message.id ? { ...item, used: true } : item));
            close();
          }}>{message.used ? "Plan created" : "Create plan for review →"}</button></div>}
        </article>)}
        {busy && <p className="copilot-thinking">Thinking about your request…</p>}<div ref={scrollEnd}/>
      </div>
      <div className="copilot-suggestions">{["How much can I spend?", "Why was my task blocked?", "Help with this page"].map(prompt => <button key={prompt} disabled={busy} onClick={() => void send(prompt)}>{prompt}</button>)}</div>
      {error && <div className="copilot-error" role="alert">{error}<button onClick={() => void send(retry, true)}>Retry</button></div>}
      <form className="copilot-composer" onSubmit={event => { event.preventDefault(); void send(input); }}>
        <label className="sr-only" htmlFor="copilot-input">Message Copilot</label>
        <textarea id="copilot-input" ref={inputRef} value={input} maxLength={2000} rows={2} placeholder="Ask a question or describe a task…" onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }}/>
        {busy ? <button type="button" onClick={() => { cancel(); setError("Request stopped. Retry when you’re ready."); }}>Stop</button> : <button type="submit" aria-label="Send message" disabled={!input.trim()}><ArrowUp size={18}/></button>}
      </form>
      <p className="copilot-footnote">Demo only. Never share private keys or recovery phrases. Payments always need a separate confirmation.</p>
    </section>}
  </>;
}
