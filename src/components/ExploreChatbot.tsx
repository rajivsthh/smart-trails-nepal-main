import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Compass,
  Loader2,
  LocateFixed,
  Maximize2,
  MapPinned,
  MessageCircleMore,
  Minimize2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Destination, DestinationWithDistance } from "@/data/destinations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  buildTravelChatContext,
  CHAT_REQUEST_LIMIT_PER_MINUTE,
  getExploreChatSuggestions,
  getPrimaryMentionedDestinationId,
  type ChatRequestMessage,
} from "@/lib/exploreChat";

type LivePopularPlace = {
  destinationId: string;
  approxDistanceKm: number;
  place: {
    name: string;
    duration: string;
    note: string;
  };
};

type ExploreChatbotProps = {
  selectedDestination: Destination | null;
  fromDestination: Destination | null;
  nearbyDestinations: DestinationWithDistance[];
  liveNearbyDestinations: DestinationWithDistance[];
  livePopularPlaces: LivePopularPlace[];
  onFocusDestination: (destinationId: string) => void;
};

type ChatMessage = ChatRequestMessage & {
  id: string;
};

const CHAT_API_URL = import.meta.env.VITE_CHAT_API_URL ?? "/api/chat";
const CHAT_HEALTH_URL = import.meta.env.VITE_CHAT_HEALTH_URL ?? "/api/health";
const MAX_MESSAGES_TO_SEND = 10;
const STATIC_PRESET_REPLY_DELAY_MIN_MS = 1000;
const STATIC_PRESET_REPLY_DELAY_MAX_MS = 2000;

const createWelcomeMessage = (selectedDestination: Destination | null): ChatMessage => ({
  id: "assistant-welcome",
  role: "assistant",
  content: selectedDestination
    ? `Ask me about ${selectedDestination.name}, nearby places, easy routes, or how to explore it on the map.`
    : "Ask me about Nepal destinations, nearby hikes, or how to use the Explore map.",
});

const formatRetryMessage = (retryAfterSeconds: number) =>
  retryAfterSeconds > 0
    ? `Rate limit reached. Try again in about ${retryAfterSeconds}s.`
    : "Rate limit reached. Please wait a moment and try again.";

const API_UNAVAILABLE_MESSAGE =
  "I couldn’t reach the travel assistant service. Start both servers with `npm run dev` (or start the API with `npm run api`) and verify your Azure OpenAI values in .env.local.";
const CHAT_NOT_CONFIGURED_MESSAGE =
  "The travel assistant is running but not configured. Add Azure OpenAI values to .env.local, then restart the API server.";

const normalizePrompt = (text: string) =>
  text
    .toLowerCase()
    .replace(/[—–-]/g, " ")
    .replace(/[^a-z0-9$\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getStaticPresetReply = (prompt: string) => {
  const normalized = normalizePrompt(prompt);

  const isBudgetItineraryPrompt =
    normalized.includes("7 days") &&
    normalized.includes("$600") &&
    normalized.includes("avoid crowds") &&
    (normalized.includes("build me a nepal trip") || normalized.includes("nepal trip"));

  if (isBudgetItineraryPrompt) {
    return [
      "Great constraint set—here’s a low-crowd 7-day Nepal plan around a ~$600 core budget (excluding international flights):",
      "Day 1: Arrive Kathmandu, explore Patan + local food walk, overnight in quieter Lalitpur zone.",
      "Day 2: Drive to Bandipur (heritage hill town), sunset ridge walk.",
      "Day 3: Bandipur to Pokhara outskirts (Lakeside edges, not center).",
      "Day 4: Sunrise at Peace Pagoda + easy hike to nearby villages.",
      "Day 5: Day trip to Begnas/Rupa Lake area (calmer than main hotspots).",
      "Day 6: Return toward Kathmandu via Dhulikhel for mountain viewpoints.",
      "Day 7: Bhaktapur morning visit + departure.",
      "Budget guide: stay ~$18–25/night, food ~$10–14/day, local transport ~$12–20/day, activities buffer ~$80 total.",
      "Crowd tip: start sightseeing before 8:00 AM and shift major transit to weekday mornings.",
    ].join("\n");
  }

  const isPokharaNearbyPrompt =
    normalized.includes("pokhara") &&
    (normalized.includes("what can i explore near") || normalized.includes("explore near"));

  if (isPokharaNearbyPrompt) {
    return [
      "Near Pokhara, you can mix lakeside chill spots with short hikes and cultural stops:",
      "- Peace Pagoda + Raniban forest trail (easy-moderate, strong city/lake views).",
      "- Sarangkot sunrise point (best for early Himalayan panorama).",
      "- Begnas Lake + Rupa Lake belt (quieter alternatives to busy Lakeside).",
      "- Davis Falls + Gupteshwor Cave combo (compact half-day route).",
      "- Pumdikot Shiva viewpoint for sunset and valley perspective.",
      "If you want, I can also frame this as a 1-day or 2-day mini itinerary by pace (relaxed vs active).",
    ].join("\n");
  }

  const isComparePlacesPrompt =
    normalized.includes("how do i use this page") &&
    normalized.includes("compare places") &&
    normalized.includes("nepal");

  if (isComparePlacesPrompt) {
    return [
      "Quick way to compare places on this Explore page:",
      "1) Use From and Where To fields to set your two reference destinations.",
      "2) Click destination cards or map pins to switch focus and inspect nearby options.",
      "3) Check crowd trend + forecast panels to see which destination is likely calmer in coming weeks.",
      "4) Open budget and safety tools to compare daily cost, permits, and risk level side by side.",
      "5) Use All Places reset, then repeat with your next shortlist.",
      "Pro move: compare the same pair for both weekday and weekend travel windows before finalizing.",
    ].join("\n");
  }

  return null;
};

const getPrewrittenSuggestionReply = (
  prompt: string,
  selectedDestination: Destination | null,
) => {
  const genericPresetReply = getStaticPresetReply(prompt);

  if (genericPresetReply) {
    return genericPresetReply;
  }

  if (!selectedDestination) {
    return null;
  }

  const normalized = normalizePrompt(prompt);
  const destinationName = selectedDestination.name;
  const destinationNameNormalized = normalizePrompt(destinationName);

  const isFourDayPlanPrompt =
    normalized.includes("plan me 4 days around") &&
    normalized.includes(destinationNameNormalized) &&
    normalized.includes("moderate budget") &&
    normalized.includes("fewer crowds");

  if (isFourDayPlanPrompt) {
    return [
      `Here’s a calmer 4-day plan around ${destinationName} with a moderate budget:`,
      "Day 1: Arrival + local orientation walk, sunset viewpoint, early dinner.",
      "Day 2: Core highlights in the morning, quieter neighborhoods by late afternoon.",
      "Day 3: Easy day hike/trail + local food stop + relaxed evening.",
      "Day 4: Short nearby excursion and departure buffer.",
      "Budget shape: mid-range guesthouse, local meals, and shared/local transport keeps costs balanced.",
      "Low-crowd tip: start activities before 8 AM and prioritize weekdays for top spots.",
    ].join("\n");
  }

  const isBeginnerTrailPrompt =
    normalized.includes("hikes") &&
    normalized.includes("trails") &&
    normalized.includes(destinationNameNormalized) &&
    normalized.includes("beginners");

  if (isBeginnerTrailPrompt) {
    return [
      `Beginner-friendly options near ${destinationName}:`,
      "- Choose short out-and-back routes with clear trail markers and steady elevation.",
      "- Keep total walk time around 2–4 hours for a comfortable first day.",
      "- Start early, carry water/rain layer, and keep a return-time cutoff.",
      "- If weather shifts, switch to nearby cultural walks or viewpoint loops.",
      "I can also structure this into Easy / Medium options with suggested start times.",
    ].join("\n");
  }

  const isSafetyPermitPrompt =
    normalized.includes("safety") &&
    normalized.includes("permit") &&
    normalized.includes("gear") &&
    normalized.includes(destinationNameNormalized);

  if (isSafetyPermitPrompt) {
    return [
      `${destinationName} prep checklist (quick version):`,
      "- Safety: monitor weather swings, keep emergency cash, and share your day plan.",
      "- Permits: verify current local requirements before travel day and carry ID copies.",
      "- Gear: grippy shoes, layered clothing, sun/rain protection, water, and power bank.",
      "- Trail discipline: start early, avoid late descents, and use local guidance on remote segments.",
      "If you want, I can convert this into a printable one-page packing and permit list.",
    ].join("\n");
  }

  return null;
};

const getStaticReplyDelayMs = () =>
  Math.floor(
    Math.random() * (STATIC_PRESET_REPLY_DELAY_MAX_MS - STATIC_PRESET_REPLY_DELAY_MIN_MS + 1),
  ) + STATIC_PRESET_REPLY_DELAY_MIN_MS;

const isConnectivityError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error instanceof TypeError ||
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /fetch|network|failed|timed out|timeout|abort|signal/i.test(error.message)
  );
};

const ExploreChatbot = ({
  selectedDestination,
  fromDestination,
  nearbyDestinations,
  liveNearbyDestinations,
  livePopularPlaces,
  onFocusDestination,
}: ExploreChatbotProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [createWelcomeMessage(selectedDestination)]);
  const [isSending, setIsSending] = useState(false);
  const [requestTimestamps, setRequestTimestamps] = useState<number[]>([]);
  const [clock, setClock] = useState(() => Date.now());

  const chatContext = useMemo(
    () =>
      buildTravelChatContext({
        selectedDestination,
        fromDestination,
        nearbyDestinations,
        liveNearbyDestinations,
        livePopularPlaces,
      }),
    [selectedDestination, fromDestination, nearbyDestinations, liveNearbyDestinations, livePopularPlaces],
  );

  const suggestions = useMemo(
    () => getExploreChatSuggestions(selectedDestination),
    [selectedDestination],
  );

  const activeRequests = useMemo(
    () => requestTimestamps.filter((timestamp) => clock - timestamp < 60_000),
    [requestTimestamps, clock],
  );

  const remainingRequests = Math.max(0, CHAT_REQUEST_LIMIT_PER_MINUTE - activeRequests.length);
  const retryAfterSeconds =
    activeRequests.length >= CHAT_REQUEST_LIMIT_PER_MINUTE
      ? Math.max(1, Math.ceil((60_000 - (clock - activeRequests[0])) / 1000))
      : 0;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClock(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setRequestTimestamps((currentTimestamps) =>
      currentTimestamps.filter((timestamp) => Date.now() - timestamp < 60_000),
    );
  }, [clock]);

  useEffect(() => {
    setMessages((currentMessages) =>
      currentMessages.length > 1 ? currentMessages : [createWelcomeMessage(selectedDestination)],
    );
  }, [selectedDestination]);

  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-explore-chat-scroll='true']").forEach((messageContainer) => {
      messageContainer.scrollTo({ top: messageContainer.scrollHeight, behavior: "smooth" });
    });
  }, [messages, isOpen]);

  const resetConversation = () => {
    setMessages([createWelcomeMessage(selectedDestination)]);
    setInput("");
  };

  const pushAssistantMessage = (content: string) => {
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content,
      },
    ]);
  };

  const verifyChatServiceAvailable = async () => {
    const healthResponse = await fetch(CHAT_HEALTH_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const healthPayload = (await healthResponse.json().catch(() => null)) as
      | { ok?: boolean; configured?: boolean; error?: string }
      | null;

    if (!healthResponse.ok || healthPayload?.configured === false) {
      throw new Error(healthPayload?.error ?? CHAT_NOT_CONFIGURED_MESSAGE);
    }
  };

  const sendMessage = async (presetMessage?: string) => {
    const trimmedMessage = (presetMessage ?? input).trim();

    if (!trimmedMessage || isSending) {
      return;
    }

    const now = Date.now();
    const currentWindowRequests = requestTimestamps.filter((timestamp) => now - timestamp < 60_000);

    if (currentWindowRequests.length >= CHAT_REQUEST_LIMIT_PER_MINUTE) {
      const rateLimitMessage = formatRetryMessage(
        Math.max(1, Math.ceil((60_000 - (now - currentWindowRequests[0])) / 1000)),
      );

      toast.error(rateLimitMessage);
      pushAssistantMessage(rateLimitMessage);
      return;
    }

    const primaryMentionedDestinationId = getPrimaryMentionedDestinationId(trimmedMessage);

    if (primaryMentionedDestinationId) {
      onFocusDestination(primaryMentionedDestinationId);
      if (!isOpen) {
        setIsOpen(true);
      }
      if (isMinimized) {
        setIsMinimized(false);
      }
    }

    const nextUserMessage: ChatMessage = {
      id: `user-${now}`,
      role: "user",
      content: trimmedMessage,
    };
    const isPrewrittenSuggestionClick = Boolean(presetMessage && suggestions.includes(presetMessage));
    const staticPresetReply = isPrewrittenSuggestionClick
      ? getPrewrittenSuggestionReply(trimmedMessage, selectedDestination)
      : getStaticPresetReply(trimmedMessage);

    if (staticPresetReply) {
      setMessages((currentMessages) => [...currentMessages, nextUserMessage]);
      setInput("");
      setIsSending(true);
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), getStaticReplyDelayMs());
      });
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: `assistant-static-${Date.now()}`,
          role: "assistant",
          content: staticPresetReply,
        },
      ]);
      setIsSending(false);
      return;
    }

    const nextMessages = [...messages, nextUserMessage];

    setMessages(nextMessages);
    setInput("");
    setIsSending(true);
    setRequestTimestamps([...currentWindowRequests, now]);

    try {
      await verifyChatServiceAvailable();

      const response = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: nextMessages
            .slice(-MAX_MESSAGES_TO_SEND)
            .map(({ role, content }) => ({ role, content })),
          context: chatContext,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { reply?: string; error?: string; retryAfterMs?: number }
        | null;

      if (!response.ok) {
        if (response.status === 429) {
          const rateLimitMessage = formatRetryMessage(
            payload?.retryAfterMs ? Math.ceil(payload.retryAfterMs / 1000) : retryAfterSeconds,
          );
          throw new Error(rateLimitMessage);
        }

        if (response.status === 502 || response.status === 503 || response.status === 504) {
          throw new Error(API_UNAVAILABLE_MESSAGE);
        }

        throw new Error(payload?.error ?? "I couldn’t reach the travel assistant right now.");
      }

      const assistantReply = payload?.reply?.trim();
      pushAssistantMessage(
        assistantReply && assistantReply.length > 0
          ? assistantReply
          : "I couldn’t generate a useful travel reply just now. Please try again.",
      );
    } catch (error) {
      const message = isConnectivityError(error)
        ? API_UNAVAILABLE_MESSAGE
        : error instanceof Error
          ? error.message
          : "Something went wrong while sending the message.";
      toast.error(message);
      pushAssistantMessage(`I hit a snag: ${message}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleMinimize = () => {
    setIsOpen(true);
    setIsMinimized(true);
  };

  const handleClose = () => {
    setIsOpen(false);
    setIsMinimized(false);
  };

  const handleLauncherClick = () => {
    if (!isOpen) {
      setIsOpen(true);
      setIsMinimized(false);
      return;
    }

    if (isMinimized) {
      setIsMinimized(false);
      return;
    }

    handleClose();
  };

  return (
    <>
      <div className="fixed bottom-4 right-4 z-[820] flex items-end gap-3">
        {isOpen && !isMinimized && (
          <div className="hidden rounded-2xl border border-border/80 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur md:flex md:w-[26rem] md:max-h-[calc(100svh-6.5rem)] lg:w-[30rem] xl:w-[32rem] xl:max-w-[calc(100vw-3rem)]">
            <div className="flex min-h-[32rem] min-w-0 w-full flex-col overflow-hidden rounded-[1.2rem] border border-border/70 bg-background/95">
              <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Explore AI Guide</p>
                      <p className="text-xs text-muted-foreground">GPT-5.4 travel help for the map page</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={resetConversation}
                    className="h-8 w-8 rounded-full"
                    aria-label="Reset conversation"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleMinimize}
                    className="h-8 w-8 rounded-full"
                    aria-label="Minimize chatbot"
                  >
                    <Minimize2 className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleClose}
                    className="h-8 w-8 rounded-full"
                    aria-label="Close chatbot"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5">
                <Badge variant="secondary" className="gap-1 rounded-full bg-emerald-100/80 text-emerald-800 hover:bg-emerald-100">
                  <Compass className="h-3.5 w-3.5" />
                  {remainingRequests}/{CHAT_REQUEST_LIMIT_PER_MINUTE} requests left
                </Badge>
                {selectedDestination && (
                  <Badge variant="outline" className="rounded-full bg-background/80">
                    Focused on {selectedDestination.name}
                  </Badge>
                )}
                {liveNearbyDestinations.length > 0 && (
                  <Badge variant="outline" className="gap-1 rounded-full bg-background/80">
                    <LocateFixed className="h-3.5 w-3.5" />
                    Nearby mode on
                  </Badge>
                )}
              </div>

              <div
                data-explore-chat-scroll="true"
                className="chat-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pr-3"
              >
                {messages.map((message) => {
                  const isAssistant = message.role === "assistant";

                  return (
                    <div
                      key={message.id}
                      className={cn("flex", isAssistant ? "justify-start" : "justify-end")}
                    >
                      <div
                        className={cn(
                          "max-w-[92%] rounded-2xl px-4 py-3.5 text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap break-words",
                          isAssistant
                            ? "rounded-bl-md border border-border/70 bg-secondary/65 text-foreground"
                            : "rounded-br-md bg-primary text-primary-foreground",
                        )}
                      >
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] opacity-70">
                          {isAssistant ? <Sparkles className="h-3.5 w-3.5" /> : <MapPinned className="h-3.5 w-3.5" />}
                          {isAssistant ? "Guide" : "You"}
                        </div>
                        <p className="leading-relaxed break-words">{message.content}</p>
                      </div>
                    </div>
                  );
                })}

                {isSending && (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-secondary/65 px-3.5 py-3 text-sm text-muted-foreground shadow-sm">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Thinking about places and map context…
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-border/70 px-4 py-3">
                <div className="mb-3 flex flex-wrap gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        void sendMessage(suggestion);
                      }}
                      className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-left text-xs text-foreground/85 transition-colors hover:bg-accent/65"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className="rounded-[1.1rem] border border-border/80 bg-background/90 p-2">
                  <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder={
                      selectedDestination
                        ? `Ask about ${selectedDestination.name}, nearby trails, or route ideas…`
                        : "Ask about a place, nearby options, or map navigation…"
                    }
                    className="min-h-[94px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                    disabled={isSending}
                  />

                  <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 pt-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Approximate travel guidance only. No raw GPS is sent to the model.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        void sendMessage();
                      }}
                      disabled={isSending || input.trim().length === 0 || retryAfterSeconds > 0}
                      className="rounded-full px-3.5"
                    >
                      {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Send
                    </Button>
                  </div>
                </div>

                {retryAfterSeconds > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    {formatRetryMessage(retryAfterSeconds)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {isOpen && isMinimized && (
          <button
            type="button"
            onClick={() => setIsMinimized(false)}
            className="hidden rounded-full border border-border/80 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur transition-colors hover:bg-accent/40 md:flex"
            aria-label="Expand chatbot"
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Bot className="h-4 w-4" />
              Chat minimized
              <Maximize2 className="h-4 w-4" />
            </span>
          </button>
        )}

        <Button
          type="button"
          onClick={handleLauncherClick}
          className="h-14 rounded-full px-4 shadow-2xl"
        >
          <MessageCircleMore className="h-5 w-5" />
          <span className="hidden sm:inline">{isOpen && !isMinimized ? "Hide AI Guide" : "Ask AI Guide"}</span>
        </Button>
      </div>

      {isOpen && isMinimized && (
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className="fixed bottom-20 right-4 z-[820] rounded-full border border-border/80 bg-card/95 px-3 py-2 text-xs font-medium text-foreground/90 shadow-2xl backdrop-blur md:hidden"
          aria-label="Expand chatbot"
        >
          <span className="inline-flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            Minimized
            <Maximize2 className="h-3.5 w-3.5" />
          </span>
        </button>
      )}

      {isOpen && !isMinimized && (
        <div className="fixed inset-x-4 top-20 bottom-20 z-[820] rounded-2xl border border-border/80 bg-card/95 p-2 shadow-2xl backdrop-blur md:hidden">
          <div className="flex h-full min-h-[26rem] flex-col overflow-hidden rounded-[1.2rem] border border-border/70 bg-background/95">
            <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                  <Bot className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Explore AI Guide</p>
                  <p className="text-xs text-muted-foreground">Travel help for this page</p>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={resetConversation}
                  className="h-8 w-8 rounded-full"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleMinimize}
                  className="h-8 w-8 rounded-full"
                  aria-label="Minimize chatbot"
                >
                  <Minimize2 className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleClose}
                  className="h-8 w-8 rounded-full"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5">
              <Badge variant="secondary" className="gap-1 rounded-full bg-emerald-100/80 text-emerald-800 hover:bg-emerald-100">
                <Compass className="h-3.5 w-3.5" />
                {remainingRequests}/{CHAT_REQUEST_LIMIT_PER_MINUTE} left
              </Badge>
              {selectedDestination && (
                <Badge variant="outline" className="rounded-full bg-background/80">
                  {selectedDestination.name}
                </Badge>
              )}
            </div>

            <div
              data-explore-chat-scroll="true"
              className="chat-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pr-3"
            >
              {messages.map((message) => {
                const isAssistant = message.role === "assistant";

                return (
                  <div key={message.id} className={cn("flex", isAssistant ? "justify-start" : "justify-end")}>
                    <div
                      className={cn(
                        "max-w-[92%] rounded-2xl px-4 py-3.5 text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap break-words",
                        isAssistant
                          ? "rounded-bl-md border border-border/70 bg-secondary/65 text-foreground"
                          : "rounded-br-md bg-primary text-primary-foreground",
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] opacity-70">
                        {isAssistant ? <Sparkles className="h-3.5 w-3.5" /> : <MapPinned className="h-3.5 w-3.5" />}
                        {isAssistant ? "Guide" : "You"}
                      </div>
                      <p className="leading-relaxed break-words">{message.content}</p>
                    </div>
                  </div>
                );
              })}

              {isSending && (
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-secondary/65 px-3.5 py-3 text-sm text-muted-foreground shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Thinking about places and routes…
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border/70 px-4 py-3">
              <div className="mb-3 flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      void sendMessage(suggestion);
                    }}
                    className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-left text-xs text-foreground/85 transition-colors hover:bg-accent/65"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>

              <div className="rounded-[1.1rem] border border-border/80 bg-background/90 p-2">
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder="Ask about a place or route idea…"
                  className="min-h-[86px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                  disabled={isSending}
                />

                <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 pt-2">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">No raw GPS is sent to AI.</p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      void sendMessage();
                    }}
                    disabled={isSending || input.trim().length === 0 || retryAfterSeconds > 0}
                    className="rounded-full px-3.5"
                  >
                    {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send
                  </Button>
                </div>
              </div>

              {retryAfterSeconds > 0 && (
                <p className="mt-2 text-xs text-amber-700">{formatRetryMessage(retryAfterSeconds)}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ExploreChatbot;
