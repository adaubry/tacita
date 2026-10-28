"use client";

import { downloadPublicImage } from "@tacita/media-pipeline";
import { useEffect, useState } from "react";

import type { Session } from "@tacita/client-core";

import { ecrireCle, lireCle } from "../../lib/preferences";
import { useSession } from "../onboarding/SessionProvider";

/**
 * Les images publiques déjà vues, en IndexedDB. Une base à part : ce ne sont pas des
 * préférences, et ce n'est jamais du contenu déchiffré — une photo de profil est servie
 * en clair à tout membre du serveur.
 */
const BASE = "tacita-images";
const STORE = "mxc";

/** `mxc` → URL d'objet, pour la durée du document. */
const affichables = new Map<string, string>();
/** Un seul téléchargement par `mxc`, même si dix avatars le demandent au même rendu. */
const enCours = new Map<string, Promise<string>>();

/**
 * **Un `mxc://` est immuable** : une nouvelle photo est un nouveau `mxc`, jamais le même
 * réécrit. Ce qui a été téléchargé une fois est donc juste pour toujours, et se garde
 * sans date d'expiration — en mémoire pour la navigation, en IndexedDB pour le lancement.
 *
 * ponytail: ni éviction ni révocation — une image par personne croisée, gardée tant que
 * le document vit et sur le disque au-delà. Borner (LRU) le jour où un compte croise
 * assez de monde pour que ça pèse.
 */
function charger(session: Session, mxc: string): Promise<string> {
  let promesse = enCours.get(mxc);
  if (!promesse) {
    promesse = (async () => {
      const local = await lireCle(globalThis.indexedDB, mxc, BASE, STORE).catch(() => undefined);
      let blob: Blob;
      if (local instanceof Blob) {
        blob = local;
      } else {
        blob = await downloadPublicImage(session, mxc);
        void ecrireCle(globalThis.indexedDB, mxc, blob, BASE, STORE).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      affichables.set(mxc, url);
      return url;
    })();
    enCours.set(mxc, promesse);
    // Un échec ne se met pas en cache : la tentative suivante doit pouvoir réussir.
    promesse.catch(() => enCours.delete(mxc));
  }
  return promesse;
}

/**
 * Un `mxc://` **public** (photo de profil, bannière) → une URL d'objet affichable.
 *
 * Les endpoints média anonymes répondent 404 depuis Synapse v1.146, et une balise `img`
 * ne sait pas porter d'en-tête `Authorization` : il faut passer par un `fetch`
 * authentifié, donc par un blob, donc par une URL d'objet.
 *
 * **L'image doit être là au premier rendu.** Sans cache, chaque montage refaisait le
 * `fetch` : quitter une conversation, c'était revoir les initiales de toute la liste
 * une fraction de seconde. L'état part donc de ce qui est déjà en mémoire.
 *
 * Un échec ne rend rien plutôt qu'une erreur : l'appelant a toujours les initiales, qui
 * sont vraies. Rien n'est journalisé — l'URL désigne le média d'une personne.
 */
export function useImageMxc(mxc: string | undefined): string | undefined {
  const { etat } = useSession();
  const session = etat.phase === "prete" ? etat.session : null;
  const [url, setUrl] = useState(() => (mxc ? affichables.get(mxc) : undefined));

  useEffect(() => {
    const deja = mxc ? affichables.get(mxc) : undefined;
    setUrl(deja);
    if (deja || !session || !mxc) return;

    let vivant = true;
    void charger(session, mxc)
      .then((objet) => {
        if (vivant) setUrl(objet);
      })
      .catch(() => {});

    return () => {
      vivant = false;
    };
  }, [session, mxc]);

  return url;
}
