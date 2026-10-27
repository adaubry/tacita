# admin — l'outil de l'auto-hébergeur

Le produit de l'administrateur, comme la PWA est celui de l'utilisateur. Il l'accompagne
de « j'ai cloné le dépôt » à « ça tourne ».

```sh
./install.sh      # sur une Ubuntu nue, une seule fois
pnpm admin init --domaine=chat.ton-domaine.fr --email=toi@ton-domaine.fr
pnpm admin dns             # les deux enregistrements A à créer, et leur état
pnpm admin certificat      # émet le certificat, une fois le DNS en place
pnpm admin doctor          # --dev sur une machine de développement
```

Les cinq étapes sont dans l'ordre, et chacune nomme la suivante. Une option inconnue
arrête la commande au lieu d'être ignorée : `--domain` répond « voulais-tu dire
`--domaine` ? » plutôt que de faire semblant de n'avoir rien reçu.

Sans `--domaine` ni `--email`, `init` les demande — à condition d'être dans un terminal ;
hors terminal il refuse et dit quelles options passer, plutôt que de bloquer sur une
question que personne ne lira.

**L'outil n'a aucune dépendance.** Il n'importe que des modules natifs de Node, donc il
tourne immédiatement après `git clone`, sans `pnpm install`. Sa seule exigence est Node 22
— et c'est la première chose que `doctor` vérifie, parce qu'Ubuntu 24.04 livre Node 18
dans apt.

## [`install.sh`](../../install.sh) — l'assistant d'installation

Un seul point d'entrée, six étapes, rien à retenir entre elles. Le script **est** le
parcours ; les commandes `pnpm admin` qu'il enchaîne restent utilisables séparément pour
qui sait déjà ce qu'il fait.

```
  Étape 1 sur 6 · Prérequis        curl, git, Docker, compose, Node 22, pnpm, certbot
  Étape 2 sur 6 · Configuration    pnpm admin init
  Étape 3 sur 6 · DNS              pnpm admin dns, avec attente gérée
  Étape 4 sur 6 · Certificat       pnpm admin certificat
  Étape 5 sur 6 · Pile             ports RTC sur ufw, puis docker compose up -d --build
  Étape 6 sur 6 · Vérification     pnpm admin doctor
```

Il reste en shell POSIX parce que c'est l'œuf et la poule : il doit tourner **avant**
Node. D'où `sh` et non `bash`, aucune dépendance, rien qui suppose un shell interactif.

**Reprenable.** Chaque étape détecte si elle est déjà faite et le dit. Relancer après une
interruption repart exactement d'où l'on en était : le domaine déjà posé dans `.env`
n'est pas redemandé, un certificat en place n'est pas réémis — le quota Let's Encrypt
n'est pas infini.

**Tout se demande avant.** Confirmation, domaine, e-mail et mot de passe sudo — ce
dernier par un `sudo -v` avant la première étape. Une question qui surgit au milieu du
travail casse le compte rendu et laisse devant un écran qui n'avance plus.

**Une ligne par étape.** La sortie des installations part dans un journal, l'écran ne
porte que `[2/3] pnpm (11.18.0) … ok`. Les longues opérations montrent un battement,
faute de quoi un build de dix minutes passe pour un écran figé — et c'est là qu'on
l'interrompt. En cas d'échec, les vingt dernières lignes du journal s'affichent : c'est
le seul endroit où le détail sert.

**L'attente se gère.** La propagation DNS ne renvoie pas à demain : elle boucle, montre
l'état, et offre de réessayer, de passer outre ou d'abandonner. En mode `--oui` elle
s'arrête net plutôt que de brûler une tentative de certificat sur un nom muet.

**Le groupe docker interrompt le parcours, et c'est correct.** Il ne prend effet qu'à la
session suivante ; poursuivre mènerait droit à un « permission denied » au démarrage de
la pile, qu'on prendrait pour une autre panne. Le script s'arrête, dit de se reconnecter,
et reprendra à l'étape 2.

**La conclusion suit le verdict.** Si le diagnostic final bloque, le script ne se félicite
pas sous les lignes ✗ qu'il vient d'afficher : il dit ce qui reste et sort en 1, pour
qu'un déploiement automatisé puisse s'y fier.

```sh
./install.sh
./install.sh --domaine=chat.mon-domaine.fr --email=moi@mon-domaine.fr --oui
./install.sh --dev
```

La version de pnpm est **lue dans [`package.json`](package.json)**, jamais recopiée ; celle de Node est
tenue avec `machine.ts` par [`infra/tests/bootstrap.test.ts`](../../infra/tests/bootstrap.test.ts).

## Pourquoi un outil et pas un runbook

Un runbook décrit l'état du dépôt au jour où il a été écrit. Celui-ci lit l'état réel.
La différence n'est pas théorique : au 25/08/2026, [`infra/README.md`](../../infra/README.md) et
`docs/LAUNCH_README.md` décrivaient encore longuement Keycloak, le realm `tacita` et
`kcadm.sh`, alors que le SSO a été supprimé et qu'aucun service `keycloak` n'existe
plus dans `docker-compose.yml`. Un administrateur qui suivait la doc créait un compte
dans un service absent.

## `init` — préparer `infra/.env`

Il fabrique ce que `doctor` se contente de réclamer : les secrets — ceux de Synapse, de
S3 et du SFU LiveKit —, la paire VAPID, le secret RPC de Garage et le domaine.

Deux règles le gouvernent, et ce sont elles qui le rendent sûr à relancer :

1. **Rejouable.** Une valeur déjà posée n'est jamais régénérée. Un macaroon réécrit
   invaliderait les sessions ouvertes ; un secret S3 réécrit ferait refuser à Garage de
   démarrer, la clé étant déjà associée à l'ancien ; un `SERVER_NAME` réécrit abandonnerait le homeserver, puisque ce
   nom entre dans chaque identifiant Matrix et chaque signature d'appareil.
2. **Rien ne s'écrase en silence.** Chaque clé est portée au compte rendu, y compris
   celles qu'il n'a pas touchées, avec `généré`, `renseigné` ou `conservé`.
   Les secrets n'y figurent que par leurs quatre premiers caractères et leur longueur : ce
   rapport s'affiche à l'écran, se copie dans un ticket et finit dans un historique de
   shell.

Les commentaires et l'ordre de `.env.example` sont préservés — ils portent l'essentiel de
ce qu'un administrateur doit comprendre, et les perdre échangerait une documentation
vivante contre une liste de clés.

**Les appels ne demandent plus rien que l'outil ne sache produire.** Il fallait deux IPv4
publiques distinctes, que `init` laissait vides faute de pouvoir les inventer — donc une
pile qui refusait de démarrer sur une machine qui n'en a qu'une. Depuis que le TURN-TLS a
quitté le 443 pour le 5349 ([`infra/rtc/README.md`](../../infra/rtc/README.md)), il ne reste que la paire de clés du
SFU, générée comme les autres secrets.

La paire VAPID est produite par `node:crypto` seul : point P-256 non compressé, 65 octets,
87 caractères en base64url, et sa clé privée de 32 octets sur 43 caractères. Plus de
conteneur jetable, plus de copier-coller — c'est le copier-coller qui produisait la panne.

## `dns` — rediriger le nom de domaine

La seule étape que l'outil ne peut pas faire à la place de l'administrateur : elle se
passe chez son registrar. La moindre des choses est donc de lui donner les deux lignes
exactes à recopier, adresse déjà remplie, plutôt qu'une phrase décrivant ce qu'il devrait
deviner.

```
  Type  Nom                  Valeur
  A     chat.tacita.fr       203.0.113.10
  A     call.chat.tacita.fr  203.0.113.10
```

L'adresse est celle des interfaces de la machine, filtrée des plages privées — boucle
locale, réseau Docker, RFC 1918 et CGNAT. Derrière un NAT il n'y en a aucune, et l'outil
le dit au lieu de proposer une adresse privée qui produirait un domaine ne résolvant que
pour son propriétaire.

Il affiche ensuite l'état constaté des deux noms, rappelle que la propagation prend le
temps qu'elle prend, et donne le `dig` qui tranche. Code de sortie 1 tant qu'un des deux
noms ne répond pas — pour qu'un script puisse attendre.

## `certificat` — émettre le certificat TLS

La seule commande qui appelle un service externe, prend des droits root et consomme un
quota : Let's Encrypt limite à **cinq certificats identiques par semaine, échecs
compris**. Elle annonce donc son plan entier — les commandes exactes, leur motif, les
avertissements — puis demande confirmation. `--oui` pour l'automatisation.

Quatre choses l'arrêtent avant qu'elle ne brûle une tentative : certbot absent, un nom
qui ne résout pas encore, le port 80 occupé, ou un certificat valide encore plus de
trente jours (`--force` passe outre).

L'ordre des deux étapes n'est pas indifférent : le **hook de renouvellement est posé
avant l'émission**, parce que certbot exécute ses hooks de déploiement dès la première
fois. Posé après, il ne servirait qu'au renouvellement suivant, et les fichiers ne
seraient pas en place pour le proxy le jour même.

`--standalone` et non `--nginx` : notre nginx tourne en conteneur, avec une configuration
montée en lecture seule, et il n'écoute pas sur le 80. En `--dev`, aucun appel à Let's
Encrypt — un auto-signé, et l'avertissement qu'il faudra l'importer comme autorité de
confiance sans quoi le service worker ne s'installera pas.

## `doctor` — vérifier avant de démarrer

**Machine** — les prémisses, dans l'ordre où elles bloquent : Linux, Node ≥ 22, mémoire et
swap, espace disque, Docker et son démon joignable, plugin compose v2, ports 80 et 443,
certbot.

Deux d'entre elles méritent leur place à elles seules. La **mémoire** : sous 4 Go sans
swap, le compilateur se fait tuer par l'OOM killer pendant `next build`, et le message ne
dit jamais que c'est la mémoire. **Docker** : « absent » et « installé mais refuse de te
parler » sont deux pannes distinctes, la seconde se résolvant par `usermod -aG docker` et
une reconnexion, pas par une réinstallation.

**Configuration** — `infra/.env` : le nom du serveur, les secrets — la paire LiveKit
comprise, depuis que les appels font partie de la pile —, la paire VAPID et son sujet, la
plage d'adresses autorisée, les clés Garage.

Les deux **pannes muettes** du dépôt sont couvertes ici. Une clé VAPID mal recopiée fait
redémarrer la passerelle en boucle pendant que `docker compose ps` affiche la pile debout.
Une `SYNAPSE_IP_RANGE_WHITELIST` vide fait que Synapse n'appelle jamais la passerelle,
alors que le pusher est bien enregistré et que l'application annonce des notifications
actives. Ni l'une ni l'autre ne se voit nulle part ailleurs.

**Certificat** — présence, `subjectAltName` couvrant `SERVER_NAME` et `call.${SERVER_NAME}`,
expiration. L'absence de SAN est le défaut le plus coûteux du lot : un certificat au seul
`/CN=` paraît valide partout sauf là où il sert — `service_identity`, donc Twisted, donc
Synapse, le refuse, et tout navigateur depuis 2017 aussi.

**DNS** — que `SERVER_NAME` et `call.${SERVER_NAME}` résolvent, et vers cette machine.
Vérifié avant certbot plutôt qu'après : un nom qui ne résout pas fait échouer l'émission
sur un message qui ne nomme jamais le DNS, et la propagation prend le temps qu'elle prend.
Une résolution vers une autre adresse **avertit sans bloquer** — le NAT sans hairpin et le
DNS à horizon partagé existent.

**Pile** — l'état réel des conteneurs : services démarrés et en bonne santé, services qui
bouclent, appels déployés, ports publiés. C'est ici que vit la panne la plus coûteuse du dépôt : un service
qui refuse sa configuration sort, redémarre, et `docker compose ps` réaffiche « Up » à
chaque relance. La passerelle push a bouclé sur le staging depuis le premier jour sans que
personne le voie.

Les **appels** y sont un avertissement, jamais un blocage : les trois services de
l'overlay RTC absents, la pile reste un déploiement légitime et l'application affiche
`RtcFociMissing`, qui est le bon diagnostic. Ce qui ne serait pas acceptable, c'est de le
découvrir au premier appel.

Et le contrôle qui protège une machine publique : l'overlay `smoke/` publie PostgreSQL et
l'API Synapse sur l'hôte. Tout port publié en plus du 443 et de ceux du média RTC bloque
hors développement — `ufw` n'y change rien, puisque Docker écrit ses règles de redirection
en amont de la chaîne qu'`ufw` contrôle. Ces ports-là sont lus dans `rtc/livekit.yaml`,
pas recopiés : c'est le fichier qui arme le SFU et le pare-feu, et une liste figée ici
dériverait en silence le jour où la plage change.

Le rapport se replie sur la largeur du terminal, en alignant les continuations sur la
colonne du texte. Mesuré : des constats à 159 caractères contre un SSH par défaut à 80,
où la continuation repartait à gauche et coupait les mots en deux.

Une vérification qui dépend d'un fichier absent ou d'une pile arrêtée est **en attente**
(`·`), pas en échec. Sans cet état, l'absence d'`infra/.env` produisait huit rouges pour
une seule cause.

## Ce qu'il ne vérifie pas encore

À dire plutôt qu'à laisser croire. Un diagnostic vert **ne signifie pas** que la pile
tourne — seulement que rien de ce qui est lu n'empêche de la démarrer.

- que la base `invite_tokens` existe — elle n'est créée qu'à la **première**
  initialisation du volume PostgreSQL ;
- la joignabilité réelle : `/_matrix/client/versions`, `/push/config`, le `.well-known` ;
- l'administration courante : comptes, reconstruction de l'annuaire, taille du stockage.

## Deux choix de conception

**Sortie plate, pas de TUI.** Le besoin est linéaire et se termine : des vérifications,
puis on lance la pile. Une liste qui s'imprime de haut en bas se relit, se copie dans un
rapport de bug, passe dans un tube et survit à une session SSH médiocre. Un plein écran
perd les trois. C'est aussi la seule forme dont la qualité se prouve en Vitest : ce qui
fait la valeur d'un TUI — redraw, focus, géométrie — ne se voit qu'à l'œil.

**Tout est pur sauf `index.ts`.** Chaque vérification est une fonction de son `Contexte` ;
elle ne touche ni le disque, ni le réseau, ni Docker. L'accès au monde est injecté, et un
test lui donne un monde inventé. C'est ce qui permet d'éprouver un certificat expiré sans
en fabriquer un, un disque plein sans en remplir un, et un démon Docker qui refuse de
parler sans en casser un.

## Limites assumées

- **Le diagnostic lit la configuration, pas le comportement.** Une valeur bien écrite peut
  être refusée par le service qui la consomme ; seule la pile démarrée le dit.
- **Les longueurs des clés VAPID sont vérifiées, pas leur validité cryptographique.** Une
  paire de 87 et 43 caractères aléatoires passerait. Le contrôle attrape le mode d'échec
  réel — la clé tronquée à la copie — pas une clé inventée.
- **`--dev` est déclaratif.** L'outil croit ce qu'on lui dit ; il ne devine pas
  l'environnement. Le poser sur un serveur public masquerait un vrai blocage.
- **Les ports ne sont pas vérifiables sans privilèges.** Se lier au 443 en simple
  utilisateur rend `EACCES`, ce qui ne permet pas de conclure. L'outil le dit au lieu de
  prétendre savoir.
- **`init` n'installe rien.** Il prépare la configuration ; le DNS reste à la charge de
  l'administrateur (`pnpm admin dns` lui donne les enregistrements exacts), le certificat
  revient à `pnpm admin certificat`, Docker et Node à `install.sh`.
- **L'adresse publique est déduite des interfaces, jamais demandée à un service tiers.**
  Sur un VPS c'est la bonne ; derrière un NAT il n'y en a aucune, et l'outil le dit plutôt
  que d'appeler un service extérieur pour la découvrir.
- **`certificat` ne rejoue pas ce que fait `certbot renew`.** Il émet ; le renouvellement
  reste au minuteur de certbot, avec le hook que la commande a posé.
- **La boucle de redémarrage se constate au présent, pas dans l'historique.** Un service
  est signalé s'il est en train de relancer, ou s'il cumule des relances *et* vient de
  démarrer. `RestartCount` seul ne suffit pas : il est cumulatif sur toute la vie du
  conteneur, redémarrages de l'hôte compris. Le croire produisait un faux positif sur ce
  dépôt même — `invite-tokens` affichait cinq relances en tournant sans interruption
  depuis quinze heures. Le revers assumé : un service qui a bouclé puis s'est stabilisé
  ne sera pas signalé, ce qui est le bon comportement pour un diagnostic du présent.
