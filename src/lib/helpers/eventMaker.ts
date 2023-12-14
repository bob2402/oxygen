import { rootTag } from "../../settings";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { get } from "svelte/store";
import { BitcoinHeightTag } from "./bitcoin";
import { unixTimeNow } from "./mundane";
import { ndk } from "$lib/stores/event_sources/relays/ndk";
import { currentUser } from "$lib/stores/hot_resources/current-user";


export default function makeEvent(settings: eventSettings): NDKEvent {
  let _ndk = get(ndk);
  if (!_ndk.signer) {
    throw new Error("no ndk signer found");
  }
  let e = new NDKEvent(_ndk);
  let author = get(currentUser)
  if (!author) {
    throw new Error("no current user")
  }
  e.author = author;
  e.kind = settings.kind;
  e.created_at = unixTimeNow();
  e.tags.push(rootTag);
  if (settings.rocket) {
    switch (typeof settings.rocket) {
      case "string":
        if (settings.rocket.length == 64) {
          e.tags.push(["e", settings.rocket, "", "rocket"]);
        }
        break;
      case "object":
        if (settings.rocket[1].length == 64) {
          e.tags.push(settings.rocket);
          break;
        }
    }
  }
  e.tags.push(BitcoinHeightTag());
  return e;
}

export type eventSettings = {
  kind: number;
  rocket?: string[] | string;
};
