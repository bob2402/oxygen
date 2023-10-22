import {
  allNostrocketEventKinds,
  kindsThatNeedConsensus,
  problemKinds,
} from "$lib/stores/event_sources/kinds";
import { rootEventID } from "../../settings";
import { problemEvents } from "$lib/stores/nostrocket_state/soft_state/problems";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { get, writable } from "svelte/store";
import { labelledTag } from "$lib/helpers/shouldBeInNDK";
import type { Account } from "$lib/stores/nostrocket_state/types";



export default function createEventpool(notstrict?: boolean) {
  const raw = writable<Map<string, NDKEvent>>(new Map<string, NDKEvent>());
  const { subscribe, set, update } = raw;
  return {
    subscribe,
    push: (e: NDKEvent): void => {
      if (problemKinds.includes(e.kind!)) {
        problemEvents.update((pe) => {
          if (!pe.get(e.id)) {
            pe.set(e.id, e);
          }
          return pe;
        });
      }
      if (!notstrict) {
        if (
          labelledTag(e, "root", "e") == rootEventID &&
          allNostrocketEventKinds.includes(e.kind ? e.kind : 0)
        ) {
          update((m) => {
            m.set(e.id, e);
            return m;
          });
        }
      }
      if (notstrict) {
        update((m) => {
          m.set(e.id, e);
          return m;
        });
      }
    },
    fetch: (id: string): NDKEvent | undefined => {
      return get(raw).get(id);
    },
    pop: (id: string): NDKEvent | undefined => {
      let val = get(raw).get(id);
      if (val) {
        update((m) => {
          m.delete(id);
          return m;
        });
      }
      return val;
    },
    singleIterator: (): NDKEvent[] => {
      let list: NDKEvent[] = [];
      get(raw).forEach((e) => {
        list.push(e);
      });
      return list;
    },
    length: (): number => {
      return get(raw).size;
    },
    stateChangeEvents: (): NDKEvent[] => {
      let list: NDKEvent[] = [];
      get(raw).forEach((e) => {
        try {
          if (kindsThatNeedConsensus.includes(e.kind!)) {
            list.push(e);
          }
        } catch {}
      });
      return list;
    },
    consensusNotes: (pubkey?:Account): NDKEvent[] => {
      let list: NDKEvent[] = [];
      get(raw).forEach((e) => {
        try {
          if (e.kind == 15172008) {
            list.push(e);
          }
        } catch {}
      });
      if (pubkey) {
        list.filter((e)=>{
          e.pubkey == pubkey
        })
      }
      return list;
    },
  };
}
