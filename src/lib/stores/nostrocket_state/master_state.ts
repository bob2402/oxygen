import { getEmbeddedEvent, labelledTag } from "$lib/helpers/shouldBeInNDK";
import { pubkeyHasVotepower } from "$lib/protocol_validators/rockets";
import { profiles } from "$lib/stores/hot_resources/profiles";
import type { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk";
import type { Mutex } from "async-mutex";
import { derived, get, writable } from "svelte/store";
import { Nostrocket, type Account } from "./types";

import makeEvent from "$lib/helpers/eventMaker";
import { unixTimeNow } from "$lib/helpers/mundane";
import {
  ignitionPubkey,
  nostrocketIgnitionEvent,
  simulateEvents,
} from "../../../settings";
import { _rootEvents, ndk_profiles } from "../event_sources/relays/ndk";
import { currentUser } from "../hot_resources/current-user";
import { HandleHardStateChangeRequest } from "./hard_state/handler";
import { ConsensusMode } from "./hard_state/types";
import { HandleIdentityEvent } from "./soft_state/identity";
import { HandleProblemEvent } from "./soft_state/simplifiedProblems";
import { HandleFAQEvent } from "./soft_state/faq";

export let IdentityOrder = new Map<string, number | undefined>();
export let finalorder = new Array<string>();

export let mempool = derived(_rootEvents, ($all) => {
  let events = new Map<string, NDKEvent>();

  for (let e of $all) {
    events.set(e.id, e);
  }
  return events;
});

let eose = writable(0);
_rootEvents.onEose(() => {
  eose.update((existing) => {
    existing++;
    return existing;
  });
});

let softStateMetadata = writable({ inState: new Set<string>() });

let fullStateTip = writable(new Nostrocket());

export let inState = writable(new Set<string>());

let softState = derived(
  [mempool, inState, softStateMetadata, fullStateTip],
  ([$mempool, $inState, $ssm, $fullStateTip]) => {
    for (let [id, e] of $mempool) {
      if (!$inState.has(id)) {
        switch (e.kind) {
          case 1602:
          case 1031:
          case 15171031:
            if (
              HandleHardStateChangeRequest(
                e,
                $fullStateTip,
                ConsensusMode.ProvisionalScum
              ) == null
            ) {
              inState.update((is) => {
                is.add(id);
                return is;
              });
              fullStateTip.set($fullStateTip);
            }
            break;
          case 1592:
            if (HandleIdentityEvent(e, $fullStateTip)) {
              for (let pk of e.getMatchingTags("p")) {
                if (IdentityOrder.get(pk[1]) == undefined) {
                  IdentityOrder.set(pk[1], e.created_at);
                } else {
                  let createdTime = [
                    IdentityOrder.get(pk[1]),
                    e.created_at,
                  ].reduce((c, n) => (n < c ? n : c));
                  IdentityOrder.set(pk[1], createdTime);
                }
                finalorder = generateArrayOfStrings(
                  IdentityOrder as Map<string, number>
                );
              }
              inState.update((is) => {
                is.add(id);
                return is;
              });
              fullStateTip.set($fullStateTip);
            }
            break;
          case 1972:
          case 1971:
            let err = HandleProblemEvent(e, $fullStateTip);
            if (err == null) {
              inState.update((is) => {
                is.add(id);
                return is;
              });
              fullStateTip.set($fullStateTip);
            }
            break;
          case 1122:
            let errFAQ = HandleFAQEvent(e, $fullStateTip);
            if (errFAQ == null) {
              inState.update((is) => {
                is.add(id);
                return is;
              });
              fullStateTip.set($fullStateTip);
            }
        }
      }
    }
    return $fullStateTip;
  }
);

export let hardStateErrors = writable<Error[]>([]);
hardStateErrors.subscribe((errors) => {
  //if (errors[0]) {console.log("HARD STATE ERROR: ", errors[0])}
});

let hardState = derived(
  [softState, inState, fullStateTip, mempool],
  ([$softState, $inState, $fullStateTip, $mempool]) => {
    //handle consensus events
    let a = Array.from($mempool, ([id, e]) => e);
    a = a.filter((ev: NDKEvent) => {
      return ev.kind == 15172008 || ev.kind == 2008;
    });
    a = a.filter((ev: NDKEvent) => {
      return pubkeyHasVotepower(ev.pubkey, $fullStateTip);
    });
    a = a.filter((ev: NDKEvent) => {
      return (
        labelledTag(ev, "previous", "e") == $fullStateTip.LastConsensusEvent()
      );
    });
    a = a.filter((ev: NDKEvent) => {
      return !$inState.has(ev.id);
    });
    a = a.filter((ev: NDKEvent) => {
      return ev.created_at;
    });
    a.sort((q, w) => {
      return q.created_at - w.created_at;
    });
    //todo: sort by votepower of the pubkey instead and process greatest votepower first
    //todo: if more than one event (multiple consensus events with different request events) then process all of them and and see which one has the greatest cumulative votepower
    //do this with a copy of the state (I think we can use get() on the store to do this?) and only update fullTipState when >50% votepower
    for (let consensusEvent of a) {
      let requestEvent = getEmbeddedEvent(consensusEvent);
      if (requestEvent) {
        let stateCopy = get(fullStateTip);
        let err = HandleHardStateChangeRequest(
          requestEvent,
          $fullStateTip,
          ConsensusMode.FromConsensusEvent
        );
        if (err != null) {
          hardStateErrors.update((errors) => {
            errors.push(err!);
            return errors;
          });
        }
        if (err == null) {
          //todo: check cumulative votepower signing this request event into the consensus chain and only include in current state if >50%
          fullStateTip.update((fst) => {
            fst.ConsensusEvents.push(consensusEvent.id);

            return fst;
          });
        }
      }
    }
  }
);

hardState.subscribe((e) => {});
//create a map of consensus events (requested state change event), and current votepower for each account, and who has signed this consensus event, so that we can produce consensus events later.

//take the current hardstate, and our current user, if we have votepower but havn't signed, produce consensus event.

//take softstate, hardstate, consensus lead, and produce consensus events raw if needed.
softState.subscribe((ss) => {
  //console.log(ss.Problems.size)
});

fullStateTip.subscribe((fst) => {
  //console.log(fst)
});

export const consensusTipState = derived(fullStateTip, ($fst) => {
  return $fst;
});

function generateArrayOfStrings(map: Map<string, number>): string[] {
  const entriesArray: [string, number][] = Array.from(map.entries());

  entriesArray.sort((a, b) => a[1] - b[1]);

  const keysInOrder: string[] = entriesArray.map((entry) => entry[0]);

  return keysInOrder;
}

let notInMempoolError = new Map<string, string>();
let lastConsensusEventAttempt: string = "";

export const nostrocketParticipants = derived(consensusTipState, ($cts) => {
  let orderedList: Account[] = [];
  recursiveList(
    nostrocketIgnitionEvent,
    ignitionPubkey,
    $cts,
    orderedList,
    "participants"
  );
  return orderedList;
});

export const currentUserIsParticipant = derived(
  [nostrocketParticipants, currentUser],
  ([$particpants, $currentUser]) => {
    if (!$currentUser) {
      return false;
    }
    if ($currentUser) {
      if ($currentUser.pubkey) {
        if ($particpants.includes($currentUser.pubkey)) {
          return true;
        }
      }
    }
    return false;
  }
);

export const nostrocketMaintiners = derived(consensusTipState, ($cts) => {
  let orderedList: Account[] = [];
  recursiveList(
    nostrocketIgnitionEvent,
    ignitionPubkey,
    $cts,
    orderedList,
    "maintainers"
  );
  return orderedList;
});

function recursiveList(
  rocket: string,
  rootAccount: Account,
  state: Nostrocket,
  orderedList: Account[],
  listType: string
) {
  if (!orderedList.includes(rootAccount)) {
    orderedList.push(rootAccount);
  }
  let r = state.RocketMap.get(rocket);
  if (r) {
    let data = r.Participants.get(rootAccount);
    if (listType == "maintainers") {
      data = r.Maintainers.get(rootAccount);
    }
    if (data) {
      for (let pk of data) {
        if (pk.length == 64 && !orderedList.includes(pk)) {
          recursiveList(rocket, pk, state, orderedList, listType);
        }
      }
    }
  }
  return orderedList;
}

nostrocketParticipants.subscribe((pkList) => {
  for (let pk of pkList) {
    let user = get(ndk_profiles).getUser({ hexpubkey: pk });
    user.fetchProfile().then(() => {
      profiles.update((data) => {
        let existing = data.get(user.pubkey);
        if (!existing) {
          data.set(user.pubkey, user);
        }
        if (
          user.profile?.name &&
          user.profile.about &&
          user.profile.displayName
        ) {
          data.set(user.pubkey, user);
        }
        return data;
      });
    });
  }
});

export const nostrocketParticipantProfiles = derived(profiles, ($p) => {
  let orderedProfiles: { profile: NDKUser; index: number }[] = [];
  for (let pk of get(nostrocketParticipants)) {
    let profile = $p.get(pk);
    if (profile) {
      orderedProfiles.push({
        profile: profile,
        index: finalorder.indexOf(pk) + 1,
      });
    }
  }
  return orderedProfiles.reverse();
});

export const nostrocketMaintainerProfiles = derived(profiles, ($p) => {
  let orderedProfiles: { profile: NDKUser; index: number }[] = [];
  let index = 0;
  for (let pk of get(nostrocketMaintiners)) {
    let profile = $p.get(pk);
    if (profile) {
      orderedProfiles.push({ profile: profile, index: index });
    }
    index++;
  }
  return orderedProfiles.reverse();
});

export async function rebroadcastEvents(mutex: Mutex) {
  let is = get(inState);
  for (let e of is) {
    let event = get(mempool).get(e);
    if (event) {
      mutex.acquire().then((release) => {
        event!.ndk = get(ndk_profiles);
        event!
          .publish()
          .then((r) => {
            console.log(r);
          })
          .finally(() => {
            release();
          });
      });
    }
  }
}

let dedupList = writable(new Set<string>());

let requiresOurConsensus = derived(
  [currentUser, fullStateTip, mempool, dedupList],
  ([$currentUser, $fullStateTip, $mempool, $deduplist]) => {
    let eventArray: NDKEvent[] = [];
    if ($currentUser) {
      if ($currentUser.pubkey == ignitionPubkey) {
        let requiresConsensus = new Set<string>();
        //for now, we are 100% centralized on the ignition pubkey
        //todo: calculate votepower for everyone
        //todo: emit online indicator as ephemeral events
        //todo: check votepower of everyone online and see if we are the highest
        for (let [id, rocket] of $fullStateTip.RocketMap) {
          if (rocket.RequiresConsensus()) {
            for (let evID of rocket._requriesConsensus) {
              requiresConsensus.add(evID);
            }
          }
        }

        for (let evID of requiresConsensus) {
          let ev = $mempool.get(evID);
          if (ev) {
            if (ev.created_at! < unixTimeNow() && !$deduplist.has(ev.id)) {
              //todo: validate max age
              eventArray.push(ev);
            }
          }
        }
        eventArray = eventArray.sort((a, b) => {
          return a.created_at! - b.created_at!;
        });
      }
    }
    return eventArray;
  }
);

let consensusChainLength = derived(fullStateTip, ($fullStateTip) => {
  return $fullStateTip.ConsensusEvents.length;
});

let ourLatestConsensusHead = derived(
  [currentUser, mempool],
  ([$currentUser, $mempool]) => {
    let OurHeads = new Set<string>();
    if ($currentUser) {
      for (let [_, e] of $mempool) {
        if (e.pubkey == $currentUser.pubkey && e.kind == 12008) {
          OurHeads.add(e.id);
        }
      }
    }
    if (OurHeads.size > 1) {
      throw new Error("this should not happen");
    }
    if (OurHeads.size == 1) {
      return $mempool.get(OurHeads.values().next().value);
    }
  }
);

let ourLatestHeadHeight = derived(ourLatestConsensusHead, ($latest) => {
  if ($latest) {
    let length = $latest.getMatchingTags("length");
    if (length[0]) {
      if (length[0][1]) {
        let int = parseInt(length[0][1], 10);
        if (int) {
          return int;
        }
      }
    }
  }
});

let newConsensusEvents = derived(
  [
    dedupList,
    requiresOurConsensus,
    fullStateTip,
    consensusChainLength,
    ourLatestHeadHeight,
    eose,
  ],
  ([
    $deduplist,
    $requiresOurConsensus,
    $fullStateTip,
    $tipLength,
    $ourLatestHeadHeight,
    $eose,
  ]) => {
    if ($ourLatestHeadHeight && $eose > 0) {
      if ($ourLatestHeadHeight <= $tipLength) {
        for (let ev of $requiresOurConsensus) {
          if (
            !$deduplist.has(ev.id) &&
            !$deduplist.has($fullStateTip.LastConsensusEvent())
          ) {
            dedupList.update((ddl) => {
              ddl.add(ev.id);
              ddl.add($fullStateTip.LastConsensusEvent());
              return ddl;
            });
            let e = makeEvent({ kind: 15172008 });
            e.tags.push(["e", ev.id, "", "request"]);
            e.tags.push(["event", JSON.stringify(ev.rawEvent())]);
            e.tags.push([
              "e",
              $fullStateTip.LastConsensusEvent(),
              "",
              "previous",
            ]);
            return e;
          }
        }
      }
    }
  }
);

let publishedConsensusEvents = derived(
  [newConsensusEvents, consensusChainLength],
  ([$newConsensusEvents, $consensusChainLength]) => {
    let ev = $newConsensusEvents;
    if (ev && !simulateEvents) {
      ev.publish().then((r) => {
        console.log(r);
        let e = makeEvent({ kind: 12008 });
        e.tags.push(["lastest", ev!.id]);
        e.tags.push(["length", $consensusChainLength.toString()]);
        e.publish().then(() => {
          return e;
        });
      });
    }
  }
);

publishedConsensusEvents.subscribe((e) => {
  console.log(e);
});
