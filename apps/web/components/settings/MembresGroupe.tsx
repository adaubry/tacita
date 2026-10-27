"use client";

import type { Session } from "@tacita/client-core";
import { canKick, invite, kick, knockers, members, powerLevelOf } from "@tacita/messaging";
import { useMemo, useState } from "react";

import { identifiantCourt } from "../../lib/identifiants";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { Button, List, ListItem, Text } from "../foundation/primitives";

interface MembresGroupeProps {
  session: Session;
  roomId: string;
}

/**
 * la liste des membres d'un groupe, avec l'exclusion **là où
 * elle est permise**.
 *
 * « Les boutons non autorisés n'apparaissent pas » (M-H) : pas d'item grisé, pas de
 * tooltip d'excuse. Un bouton visible qu'on ne peut pas actionner apprend à ignorer les
 * boutons. Le droit vient du paquet (`canKick`), qui croise le seuil du salon et les
 * deux power levels — le shard ne le recalcule pas.
 *
 * Le power level est affiché **en nombre**, tel que Matrix le porte : `@tacita/messaging` refuse
 * les rôles nommés, et inventer « modérateur » à l'affichage serait la même invention un
 * cran plus bas.
 *
 * **Les demandes d'entrée sont au-dessus de la liste** (voie A) : quelqu'un qui a
 * suivi un lien de groupe a frappé, et attend. Elles sont ici plutôt que dans l'écran des
 * demandes d'amis (M-G) parce qu'elles concernent **ce groupe** et que n'importe lequel
 * de ses membres peut confirmer — c'est là qu'on regarde quand on gère un groupe.
 * Accepter est une `invite` native : le sas se referme par le chemin de D-09, sans état
 * parallèle à tenir.
 */
export function MembresGroupe({ session, roomId }: MembresGroupeProps) {
  const [version, setVersion] = useState(0);
  const [echec, setEchec] = useState<string | undefined>();

  // `version` est la dépendance qui compte : le paquet rend une vue de l'état du salon,
  // et c'est l'exclusion qui dit qu'elle a changé (même motif qu'en M-D).
  const liste = useMemo(() => members(session, roomId), [session, roomId, version]);
  const attente = useMemo(() => knockers(session, roomId), [session, roomId, version]);

  return (
    <div style={{ display: "grid", gap: "var(--spacing-2)", padding: "var(--spacing-3)" }}>
      {attente.length > 0 && (
        <div style={{ display: "grid", gap: "var(--spacing-1)" }}>
          <Text type="label">Demandes d&apos;entrée</Text>
          <Text type="supporting" color="secondary">
            Ces personnes ont suivi un lien d&apos;invitation vers ce groupe.
          </Text>
          <List>
            {attente.map((candidat) => (
              <ListItem
                key={candidat.userId}
                label={candidat.name || identifiantCourt(candidat.userId)}
                description={candidat.userId}
                startContent={
                  <ConversationAvatar nom={candidat.name || identifiantCourt(candidat.userId)} direct taille={36} cle={candidat.userId} />
                }
                endContent={
                  <Button
                    label="Laisser entrer"
                    variant="secondary"
                    onClick={() => {
                      setEchec(undefined);
                      void invite(session, roomId, candidat.userId)
                        .then(() => setVersion((tour) => tour + 1))
                        .catch(() =>
                          setEchec("La confirmation a échoué. Vous n'avez peut-être pas le droit d'inviter."),
                        );
                    }}
                  />
                }
                style={{ minHeight: 44 }}
              />
            ))}
          </List>
        </div>
      )}

      <Text type="supporting" color="secondary" hasTabularNumbers>
        {liste.length} membres
      </Text>

      <List>
        {liste.map((membre) => {
          const niveau = powerLevelOf(session, roomId, membre.userId);
          return (
            <ListItem
              key={membre.userId}
              label={membre.name || identifiantCourt(membre.userId)}
              description={niveau > 0 ? `${membre.userId} · niveau ${niveau}` : membre.userId}
              startContent={<ConversationAvatar nom={membre.name || identifiantCourt(membre.userId)} direct taille={36} cle={membre.userId} />}
              endContent={
                canKick(session, roomId, membre.userId) ? (
                  <Button
                    label="Exclure"
                    variant="ghost"
                    onClick={() => {
                      setEchec(undefined);
                      void kick(session, roomId, membre.userId)
                        .then(() => setVersion((tour) => tour + 1))
                        .catch(() =>
                          setEchec(
                            "L'exclusion a été refusée. Vos droits ont peut-être changé depuis l'ouverture de cet écran.",
                          ),
                        );
                    }}
                  />
                ) : undefined
              }
              style={{ minHeight: 44 }}
            />
          );
        })}
      </List>

      {echec && (
        <Text type="supporting" color="secondary">
          {echec}
        </Text>
      )}
    </div>
  );
}
