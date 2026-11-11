import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import axios from "axios";
import { subscribeToRelay } from "./subscribeToRelay";
import { usePopper } from "react-popper";

import Layout from "./components/Layout";
import Header from "./components/Header";
import Footer from "./components/Footer";

import Card from "./components/utility/Card";
import CopyText from "./components/utility/CopyText";
import ConnectClient from "./components/ConnectClient";
import TotalBackups from "./components/TotalBackups";
import LatestActions from "./components/LatestActions";
import PublicRelaysModal from "./components/PublicRelaysModal";
import AccountHeading from "./components/AccountHeading";
import AccountOverlay from "./components/AccountOverlay";
import Dialog from "./components/Dialog";
import {
  accountLabel,
  latestProfiles,
  npubEncode,
  setAccountColors,
  shortNpub,
} from "./nostr";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

import {
  PORT,
  WEB_SOCKET_RELAY_URL, // Websocket URL of the private relay
  HTTP_RELAY_URL, // http URL of the private relay
  RELAY_PROXY_URL,
} from "./constants/constants";

// Event kinds that we want to render in the UI
const supportedEventKinds = {
  0: {
    icon: "📝",
    name: "Profile Update",
  },
  1: {
    icon: "💭",
    name: "Post",
    showContent: true,
  },
  2: {
    icon: "📡",
    name: "Relay Update",
  },
  3: {
    icon: "🤝",
    name: "Following Update",
  },
  4: {
    icon: "🔏",
    name: "Encrypted DM",
  },
  5: {
    icon: "🗑",
    name: "Deleted Action",
  },
  6: {
    icon: "🔁",
    name: "Repost",
  },
  7: {
    icon: "🤙",
    name: "Reaction",
  },
  40: {
    icon: "🧙‍♂️",
    name: "Channel Creation",
    showContent: true,
    contentKey: "name",
  },
  41: {
    icon: "🪄",
    name: "Channel Update",
    showContent: true,
    contentKey: "name",
  },
  42: {
    icon: "📢",
    name: "Channel Message",
    showContent: true,
  },
  43: {
    icon: "🙈",
    name: "Hid Message",
  },
  44: {
    icon: "🙊",
    name: "Muted User",
  },
  16: {
    icon: "🔁",
    name: "Repost",
  },
  20: {
    icon: "🖼️",
    name: "Photo",
  },
  21: {
    icon: "🎬",
    name: "Video",
  },
  22: {
    icon: "🎞️",
    name: "Short Video",
  },
  1068: {
    icon: "📊",
    name: "Poll",
  },
  1111: {
    icon: "💬",
    name: "Comment",
  },
  9735: {
    icon: "⚡",
    name: "Zap Receipt",
  },
  30023: {
    icon: "📰",
    name: "Article",
  },
  10002: {
    icon: "📡",
    name: "Relay Update",
  },
  22242: {
    icon: "🔓",
    name: "Authenticated Relay",
  },
  other: {
    icon: "🛠",
    name: "Other Action",
  },
};

// Total events we want to render in each activity list
const eventsToRenderLimit = 300;
// Events fetched for the whole relay, and again for each synced account, so one
// busy account (or client) can't push the others out of the dashboard
const eventsPerSubscription = 3000;

// The dashboard keeps the fields it shows: the kind, author, time, content and tags
function toStoredEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    !Number.isInteger(event.created_at) ||
    !Number.isInteger(event.kind) ||
    typeof event.content !== "string"
  )
    return null;
  const { id, pubkey, kind, created_at, content } = event;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  return { id, pubkey, kind, created_at, content, tags };
}

function sameAccounts(a, b) {
  return (
    a !== null &&
    a.length === b.length &&
    a.every(
      (account, index) =>
        account.identifier === b[index].identifier &&
        account.pubkey === b[index].pubkey,
    )
  );
}

function HelpIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="8" />
      <path d="M7.6 7.7a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2.2-2.4 3.6" />
      <circle cx="10" cy="14.6" r="0.4" fill="currentColor" />
    </svg>
  );
}

export default function App() {
  // State to store events from websocket
  const [events, setEvents] = useState([]);
  // State to store the connection status of websocket
  const [isConnected, setIsConnected] = useState(false);
  // State to keep track of whether all stored events have been fetched
  const [hasFetchedAllEvents, setHasFetchedAllEvents] = useState(false);
  // State to store the relay info as per NIP-11: https://github.com/nostr-protocol/nips/blob/master/11.md
  const [relayInformationDocument, setRelayInformationDocument] = useState({});
  // The accounts being synced: [{ identifier, pubkey }], or null until loaded
  const [accounts, setAccounts] = useState(null);
  // Whether the Get started panel was opened with the help button
  const [showHelp, setShowHelp] = useState(false);
  // The column (account pubkey, or "other") shown in the full-screen overlay
  const [overlayKey, setOverlayKey] = useState(null);
  // The Others deletion: null, "confirm" or "deleting"
  const [deleteState, setDeleteState] = useState(null);
  // Bumped when a new profile or relay list arrives, to fetch the history again
  const [historyNonce, setHistoryNonce] = useState(0);
  // State to track the public relays modal
  const [showModal, setShowModal] = useState(false);
  const [isPreventModalClose, setIsPreventModalClose] = useState(false);
  // State to store the reference and popper elements for the public relays modal
  const [offset, setOffset] = useState(
    window.innerWidth > 768 ? [-170, 10] : [0, 10],
  );
  const [referenceElement, setReferenceElement] = useState(null);
  const [popperElement, setPopperElement] = useState(null);
  const { styles, attributes, update } = usePopper(
    referenceElement,
    popperElement,
    {
      placement: "bottom-start",
      modifiers: [
        {
          name: "offset",
          options: {
            offset: offset,
          },
        },
      ],
    },
  );
  const updatePopper = useRef(update);
  const socketRef = useRef(null);
  // Incoming events are collected here and added to the state a few times a
  // second, rather than re-sorting the whole list for every event
  const pendingEvents = useRef(new Map());
  const flushTimer = useRef(null);
  const loadedRef = useRef(false);

  const pubkeys = (accounts || [])
    .map((account) => account.pubkey)
    .filter(Boolean);
  const pubkeysKey = pubkeys.join(",");
  // Before anything renders an avatar, so every face uses the same colours
  setAccountColors(pubkeys);

  useEffect(() => {
    const controller = new AbortController();
    const subscriptionID = "dashboard";

    function flush() {
      flushTimer.current = null;
      const incoming = [...pendingEvents.current.values()];
      pendingEvents.current.clear();
      if (!incoming.length) return;
      if (
        loadedRef.current &&
        incoming.some((event) => event.kind === 0 || event.kind === 10002)
      )
        setHistoryNonce((previous) => previous + 1);
      setEvents((previous) => {
        const known = new Set(previous.map((event) => event.id));
        const added = incoming.filter((event) => !known.has(event.id));
        if (!added.length) return previous;
        return [...added, ...previous].sort(
          (a, b) => b.created_at - a.created_at,
        );
      });
    }

    const disconnect = subscribeToRelay(WEB_SOCKET_RELAY_URL, {
      onOpen: (socket) => {
        socketRef.current = socket;
        setIsConnected(true);
        setHasFetchedAllEvents(false);
        loadedRef.current = false;
        pendingEvents.current.clear();
        setEvents([]);
        socket.send(
          JSON.stringify([
            "REQ",
            subscriptionID,
            { limit: eventsPerSubscription },
          ]),
        );
        fetch(HTTP_RELAY_URL, {
          headers: { Accept: "application/nostr+json" },
          signal: controller.signal,
        })
          .then(async (response) => {
            if (response.ok) setRelayInformationDocument(await response.json());
          })
          .catch((error) => {
            if (error.name !== "AbortError")
              console.error("Could not load relay information");
          });
      },
      onMessage: (data) => {
        if (data[1] !== subscriptionID && data[1] !== "accounts") return;
        if (data[0] === "EOSE") {
          if (data[1] === subscriptionID) {
            flush();
            loadedRef.current = true;
            setHasFetchedAllEvents(true);
          }
        } else if (data[0] === "EVENT") {
          const event = toStoredEvent(data[2]);
          if (!event) return;
          pendingEvents.current.set(event.id, event);
          if (!flushTimer.current) flushTimer.current = setTimeout(flush, 250);
        }
      },
      onClose: () => {
        socketRef.current = null;
        setIsConnected(false);
      },
    });
    return () => {
      controller.abort();
      clearTimeout(flushTimer.current);
      disconnect();
    };
  }, []);

  // Keep the list of synced accounts up to date (they can be added or removed
  // in the Sync from public relays panel)
  useEffect(() => {
    let stopped = false;
    async function loadAccounts() {
      try {
        const { data } = await axios.get(`${RELAY_PROXY_URL}/connectionStatus`);
        if (stopped || !Array.isArray(data?.identifiers)) return;
        const loaded = data.identifiers.map(({ identifier, pubkey }) => ({
          identifier,
          pubkey: pubkey || null,
        }));
        setAccounts((previous) =>
          sameAccounts(previous, loaded) ? previous : loaded,
        );
      } catch {
        // The relay proxy may be starting; try again on the next poll
      }
    }
    loadAccounts();
    const timer = setInterval(loadAccounts, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Fetch each account's own recent events and every account's profile. Sending
  // REQ again with the same id replaces the previous filters (NIP-01).
  useEffect(() => {
    const socket = socketRef.current;
    if (!isConnected || !socket) return;
    const keys = pubkeysKey ? pubkeysKey.split(",") : [];
    // The relay ignores a REQ that reuses an open subscription id, so the
    // previous one is closed first
    socket.send(JSON.stringify(["CLOSE", "accounts"]));
    if (keys.length === 0) return;
    socket.send(
      JSON.stringify([
        "REQ",
        "accounts",
        { kinds: [0], authors: keys },
        ...keys.map((pubkey) => ({
          authors: [pubkey],
          limit: eventsPerSubscription,
        })),
      ]),
    );
  }, [isConnected, pubkeysKey]);

  // Earlier versions of each account's profile and relay list, kept by the
  // relay proxy (the relay itself keeps only the newest), so updates can show
  // what changed. They're added to the events like any other action.
  useEffect(() => {
    if (!isConnected || !pubkeysKey) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const { data } = await axios.get(`${RELAY_PROXY_URL}/history`);
        if (stopped || !data || typeof data !== "object") return;
        const versions = Object.values(data)
          .flat()
          .map(toStoredEvent)
          .filter(Boolean);
        if (!versions.length) return;
        setEvents((previous) => {
          const known = new Set(previous.map((event) => event.id));
          const added = versions.filter((event) => !known.has(event.id));
          if (!added.length) return previous;
          return [...added, ...previous].sort(
            (a, b) => b.created_at - a.created_at,
          );
        });
      } catch {
        // Older relay proxy, or not reachable yet: updates show without changes
      }
    }, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [isConnected, pubkeysKey, historyNonce]);

  // Update popper offset for the public relays modal when the window is resized
  useEffect(() => {
    const handleResize = () => {
      setOffset(window.innerWidth > 768 ? [-150, 10] : [0, 10]);
      updatePopper.current?.();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const profiles = useMemo(() => latestProfiles(events), [events]);

  // For each profile or relay list update, the version before it
  const previousVersions = useMemo(() => {
    const groups = {};
    for (const event of events) {
      if (event.kind !== 0 && event.kind !== 10002) continue;
      (groups[`${event.pubkey}:${event.kind}`] ??= []).push(event);
    }
    const previous = {};
    for (const group of Object.values(groups)) {
      group.sort((a, b) => a.created_at - b.created_at);
      group.forEach((event, index) => {
        if (index > 0) previous[event.id] = group[index - 1];
      });
    }
    return previous;
  }, [events]);
  const previousOf = (event) => previousVersions[event.id] || null;
  const hasAccounts = pubkeys.length > 0;
  // With no accounts, Get started is a panel on the page; once there are
  // accounts, the help button opens it in a small overlay
  const showGetStarted = accounts !== null && !hasAccounts;
  const closeHelp = useCallback(() => setShowHelp(false), []);

  // One column per synced account, then everything else saved to the relay
  // (for example by a client connected straight to it)
  const columns = useMemo(() => {
    if (!hasAccounts) return [];
    const synced = new Set(pubkeys);
    const list = (accounts || [])
      .filter((account) => account.pubkey)
      .map((account) => {
        const profile = profiles[account.pubkey];
        return {
          key: account.pubkey,
          label: accountLabel(account, profile),
          picture: profile?.picture || "",
          npub: npubEncode(account.pubkey),
          events: events.filter((event) => event.pubkey === account.pubkey),
        };
      });
    const others = events.filter((event) => !synced.has(event.pubkey));
    if (others.length)
      list.push({
        key: "other",
        label: "Others",
        other: true,
        events: others,
      });
    return list;
  }, [accounts, events, profiles, hasAccounts, pubkeysKey]);

  // A name for someone else's pubkey: a synced account's name, or a short npub
  const nameFor = (pubkey) => {
    const account = (accounts || []).find((item) => item.pubkey === pubkey);
    if (account) return accountLabel(account, profiles[pubkey]);
    return profiles[pubkey]?.name || shortNpub(pubkey);
  };

  const overlayColumn = columns.find((column) => column.key === overlayKey);
  const othersColumn = columns.find((column) => column.other);
  const closeDelete = useCallback(
    () => setDeleteState((state) => (state === "deleting" ? state : null)),
    [],
  );

  async function deleteOthers() {
    setDeleteState("deleting");
    try {
      const { data } = await axios.post(`${RELAY_PROXY_URL}/delete-others`);
      const synced = new Set(pubkeys);
      setEvents((previous) =>
        previous.filter((event) => synced.has(event.pubkey)),
      );
      setOverlayKey((key) => (key === "other" ? null : key));
      toast.success(
        `Deleted ${data.deleted.toLocaleString()} actions from other accounts`,
      );
    } catch (error) {
      toast.error(
        error.response?.data?.error ||
          "Could not delete the other accounts' actions",
      );
    } finally {
      setDeleteState(null);
    }
  }
  const closeOverlay = useCallback(() => setOverlayKey(null), []);

  const headerButtonClass = (active) =>
    `self-center p-3 m-1 rounded-md bg-white ring-1 ring-gray-900/5 dark:ring-white/10 hover:bg-[#CEC8F4] dark:hover:bg-[#264D96] ${
      active
        ? "bg-[#CEC8F4] dark:bg-[#264D96] ring-violet-400 dark:ring-white/30"
        : "dark:bg-slate-900"
    }`;

  return (
    <Layout>
      <ToastContainer
        position="bottom-center"
        autoClose={8000} // close toast after 8 seconds
        hideProgressBar={true}
        closeOnClick={false}
        pauseOnFocusLoss={false}
        draggable={false}
        pauseOnHover={false}
        closeButton={false}
      />
      <div className="container mx-auto px-4 pb-10 min-[1200px]:pb-28">
        <Header isConnected={isConnected}>
          <div className="flex">
            <button
              type="button"
              title="Get started"
              aria-label="Get started"
              aria-pressed={showGetStarted || showHelp}
              disabled={!hasAccounts}
              onClick={() => setShowHelp(true)}
              className={`${headerButtonClass(
                showGetStarted || showHelp,
              )} text-slate-700 dark:text-slate-200 disabled:cursor-default`}
            >
              <HelpIcon />
            </button>
            <button
              type="button"
              title="Sync from public relays"
              aria-label="Sync from public relays"
              ref={setReferenceElement}
              onClick={(event) => {
                event.stopPropagation();
                setShowModal((prevState) => !prevState); // toggles the current state of showModal
              }}
              className={headerButtonClass(showModal)}
            >
              <div className="w-5 h-5 bg-relays-modal-icon-light-mode dark:bg-relays-modal-icon-dark-mode bg-no-repeat bg-center"></div>
            </button>
            <div className="relay-url-container flex self-center after:bg-white dark:after:bg-slate-900 p-3 rounded-md after:rounded-md">
              <span className="text-sm text-slate-900 dark:text-slate-50">
                Relay URL:&nbsp;&nbsp;
              </span>
              <CopyText value={WEB_SOCKET_RELAY_URL} />
            </div>
          </div>
        </Header>

        <main className="mb-10">
          {hasAccounts ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 sm:gap-8">
              <Card
                className={`lg:col-span-2 ${
                  columns.length > 5 ? "xl:col-span-3" : "xl:col-span-2"
                } min-w-0`}
              >
                <TotalBackups
                  loading={!hasFetchedAllEvents}
                  events={events}
                  columns={columns}
                  supportedEventKinds={supportedEventKinds}
                />
              </Card>

              {columns.map((column) => (
                <Card
                  key={column.key}
                  // The same height as a full panel when side by side, even
                  // with only a few actions (alone on a row, it wouldn't be
                  // stretched to match its neighbours)
                  className="min-w-0 lg:min-h-[34.7rem]"
                  heading={
                    <AccountHeading
                      column={column}
                      onMore={() => setOverlayKey(column.key)}
                      onDelete={
                        column.other
                          ? () => setDeleteState("confirm")
                          : undefined
                      }
                    />
                  }
                >
                  <LatestActions
                    loading={!hasFetchedAllEvents}
                    events={column.events}
                    eventsToRenderLimit={eventsToRenderLimit}
                    supportedEventKinds={supportedEventKinds}
                    nameFor={nameFor}
                    previousOf={previousOf}
                    emptyMessage={
                      column.other
                        ? "Nothing else has been saved to your relay yet."
                        : "This account's activity will show up here once it has been backed up."
                    }
                  />
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-5 xl:grid-cols-3 gap-6 sm:gap-8">
              {showGetStarted && (
                <Card
                  className="order-last xl:order-first md:col-span-5 xl:col-span-1"
                  heading="Get started"
                >
                  <ConnectClient relayPort={PORT} />
                </Card>
              )}

              <Card
                className="col-1 md:col-span-2 xl:col-span-1"
                heading="Total actions"
              >
                <TotalBackups
                  loading={!hasFetchedAllEvents}
                  events={events}
                  columns={[]}
                  supportedEventKinds={supportedEventKinds}
                />
              </Card>

              <Card
                className="col-1 md:col-span-3 xl:col-span-1"
                heading="Latest actions"
              >
                <LatestActions
                  loading={!hasFetchedAllEvents}
                  events={events}
                  eventsToRenderLimit={eventsToRenderLimit}
                  supportedEventKinds={supportedEventKinds}
                  nameFor={nameFor}
                  previousOf={previousOf}
                />
              </Card>
            </div>
          )}
        </main>

        {showModal && (
          <div
            ref={setPopperElement}
            style={styles.popper}
            {...attributes.popper}
          >
            <PublicRelaysModal
              onClose={() => {
                if (isPreventModalClose) return;
                setShowModal(false);
              }}
              isPreventModalClose={isPreventModalClose}
              setIsPreventModalClose={setIsPreventModalClose}
              accountInfo={(pubkey) => ({
                picture: profiles[pubkey]?.picture || "",
                name: profiles[pubkey]?.name || "",
              })}
            />
          </div>
        )}

        {showHelp && hasAccounts && (
          <Dialog title="Get started" onClose={closeHelp}>
            <ConnectClient relayPort={PORT} />
          </Dialog>
        )}

        {deleteState && othersColumn && (
          <Dialog
            title="Delete other accounts' actions?"
            onClose={closeDelete}
            footer={
              <>
                <button
                  type="button"
                  onClick={closeDelete}
                  disabled={deleteState === "deleting"}
                  className="rounded-md px-4 py-2 text-sm text-slate-700 dark:text-slate-200 ring-1 ring-slate-900/10 dark:ring-white/10 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={deleteOthers}
                  disabled={deleteState === "deleting"}
                  className="rounded-md px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60"
                >
                  {deleteState === "deleting" ? "Deleting..." : "Delete"}
                </button>
              </>
            }
          >
            <div className="px-6 sm:px-10 py-5 space-y-3 text-sm text-slate-700 dark:text-slate-300">
              <p>
                This deletes everything on your relay that wasn&apos;t posted by
                one of your synced accounts: about{" "}
                {othersColumn.events.length.toLocaleString()} actions
                {othersColumn.events.length >= eventsPerSubscription
                  ? " or more"
                  : ""}
                .
              </p>
              <p>
                It can&apos;t be undone. If you post from an account that
                isn&apos;t synced, add it in Sync from public relays first to
                keep its backup.
              </p>
            </div>
          </Dialog>
        )}

        {overlayColumn && (
          <AccountOverlay
            column={overlayColumn}
            supportedEventKinds={supportedEventKinds}
            nameFor={nameFor}
            previousOf={previousOf}
            fetchLimit={eventsPerSubscription}
            onClose={closeOverlay}
          />
        )}
      </div>
      <Footer relayVersion={relayInformationDocument.version} />
    </Layout>
  );
}
