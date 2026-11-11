import { motion, LayoutGroup } from "framer-motion";

import moment from "moment";
import {
  actionDetail,
  parseJson,
  profileChanges,
  relayChanges,
  shortNpub,
} from "../nostr";
import ChangeDetail from "./ChangeDetail";
import PostContent from "./PostContent";

// The post inside a repost (kind 6 or 16): its author and text, when included
function repostedPost(event) {
  const inner = parseJson(event.content);
  const valid = (value) =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : "";
  const author =
    valid(inner?.pubkey) ||
    valid(
      (event.tags || [])
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1])[0],
    );
  const text =
    typeof inner?.content === "string" && inner.kind === 1
      ? inner.content.trim()
      : "";
  return { author, text };
}

export default function LatestActions({
  loading,
  events,
  eventsToRenderLimit,
  supportedEventKinds,
  nameFor = shortNpub,
  // The version before a profile or relay list update, if the history has one
  previousOf = () => null,
  // In the account overlay the list fills the overlay instead of scrolling itself
  fullHeight = false,
  emptyMessage = "Your Nostr activity will show up here after you have connected your client.",
}) {
  let eventsToRender = [];
  // Filter, sort and slice the events array to get the eventsToRender array
  // We run this after loading to not cause unnecessary compute while the
  // relay is sending the initial batch of events
  if (!loading) {
    eventsToRender = events
      .filter(({ kind }) => !!supportedEventKinds[kind])
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, eventsToRenderLimit);
  }

  function getFormattedDate(timestamp) {
    return moment.unix(timestamp).format("HH:mm MMM DD, YYYY");
  }

  if (loading) {
    return (
      <ul
        className={`${
          fullHeight ? "" : "overflow-y-auto max-h-[28.8rem]"
        } overflow-x-hidden pt-2 !scrollbar-thin !scrollbar-w-1 !scrollbar-thumb-rounded-full !scrollbar-track-transparent !scrollbar-thumb-black/10 dark:!scrollbar-thumb-white/10 mx-[0.15rem]`}
      >
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((item, index) => {
          return (
            <li key={item} className="relative px-10 py-3">
              {/* <img className="w-14 h-14 object-cover rounded-full mr-3" src="avatar.png" /> */}
              <span className="absolute z-[2] left-10 flex items-center justify-center w-7 h-7 text-sm sm:text-lg rounded-md bg-white shadow-sm ring-1 ring-slate-900/5 dark:bg-slate-700 dark:ring-0 dark:shadow-none dark:highlight-white/5" />
              <div className="pl-9 mt-1">
                <div className="flex justify-between mb-2">
                  <span className="bg-slate-200 dark:bg-slate-600/70 h-2 mt-1 rounded-full animate-pulse px-8 text-xs ml-1">
                    &nbsp;
                  </span>
                  <span className="bg-slate-200 dark:bg-slate-600/70 h-2 mt-1 rounded-full animate-pulse px-16 text-xs ml-1">
                    &nbsp;
                  </span>
                </div>
              </div>
              <span
                className={`absolute z-[1] ${index === 0 ? "top-4" : "top-0"} ${
                  index === 9 ? "bottom-4" : "bottom-0"
                } left-[3.33rem] w-px bg-slate-200 dark:bg-slate-700`}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  if (eventsToRender.length) {
    return (
      <ul
        className={`${
          fullHeight ? "" : "overflow-y-auto max-h-[28.8rem]"
        } overflow-x-hidden pt-2 !scrollbar-thin !scrollbar-w-1 !scrollbar-thumb-rounded-full !scrollbar-track-transparent !scrollbar-thumb-black/10 dark:!scrollbar-thumb-white/10 mx-[0.15rem]`}
      >
        <LayoutGroup>
          {eventsToRender.map((event, index) => {
            const { id, kind, created_at, content } = event;
            const eventKind = supportedEventKinds[kind];
            const shownContent = eventKind.showContent
              ? eventKind.contentKey
                ? parseJson(content)?.[eventKind.contentKey]
                : content
              : "";
            const isRepost = kind === 6 || kind === 16;
            const reposted = isRepost ? repostedPost(event) : null;
            const detail =
              eventKind.showContent || isRepost
                ? ""
                : actionDetail(event, nameFor);
            const previous =
              kind === 0 || kind === 10002 ? previousOf(event) : null;
            const changes =
              kind === 0
                ? profileChanges(event, previous)
                : relayChanges(event, previous);

            return (
              <motion.li
                initial={{
                  scale: 0.2,
                  opacity: 0,
                }}
                animate={{
                  scale: 1,
                  opacity: 1,
                }}
                exit={{
                  scale: 0,
                  opacity: 0,
                }}
                layout
                key={id}
                className="relative px-10 py-3"
              >
                <span className="absolute z-[2] left-10 flex items-center justify-center w-7 h-7 text-sm rounded-md bg-white shadow-sm ring-1 ring-slate-900/5 dark:bg-slate-700 dark:ring-0 dark:shadow-none dark:highlight-white/5">
                  {eventKind.icon}
                </span>
                <div className="pl-9 mt-1">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-slate-700 text-sm dark:text-slate-200">
                      {eventKind.name}
                    </span>
                    <span className="text-slate-400 dark:text-slate-500 tracking-tighter text-xs">
                      {getFormattedDate(created_at)}
                    </span>
                  </div>
                  {typeof shownContent === "string" && shownContent ? (
                    <div className="bg-slate-50 dark:bg-white/5 p-2 rounded shadow-sm ring-1 ring-slate-900/5 dark:ring-slate-700">
                      {eventKind.contentKey ? (
                        <p className="text-slate-700 dark:text-slate-300 text-sm break-words">
                          {shownContent}
                        </p>
                      ) : (
                        <PostContent text={shownContent} />
                      )}
                    </div>
                  ) : null}
                  {isRepost ? (
                    <div className="-mt-0.5 mb-1 rounded-md border-l-[3px] border-violet-400 dark:border-violet-400/70 bg-violet-50/80 dark:bg-violet-500/10 px-2.5 py-2">
                      <p className="text-xs text-violet-700 dark:text-violet-300 mb-1">
                        {reposted.author
                          ? `Reposted from ${nameFor(reposted.author)}`
                          : "Reposted a post"}
                      </p>
                      {reposted.text ? (
                        <PostContent text={reposted.text} small />
                      ) : null}
                    </div>
                  ) : null}
                  {changes ? (
                    <ChangeDetail kind={kind} changes={changes} />
                  ) : detail ? (
                    <p
                      className="-mt-1 mb-1 text-slate-500 dark:text-slate-400 text-xs break-words overflow-hidden"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {detail}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`absolute z-[1] ${index === 0 ? "top-4" : "top-0"} 
                  ${eventsToRender.length === 1 ? "hidden" : ""}
                  ${
                    index === eventsToRender.length - 1 ? "top-[-2rem]" : ""
                  } bottom-0 left-[3.33rem] w-px h-full bg-slate-200 dark:bg-slate-700`}
                />
              </motion.li>
            );
          })}
        </LayoutGroup>
      </ul>
    );
  }

  return (
    <p className="px-10 py-5 text-slate-700 dark:text-slate-300 leading-relaxed mb-3">
      {emptyMessage}
    </p>
  );
}
