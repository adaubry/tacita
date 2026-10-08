#!/bin/sh
# Sauvegarde et restauration de l'état durable de la pile Tacita.
#
# Tout ce qui survit à un redéploiement vit dans trois volumes Docker nommés
# (cf. `docker-compose.yml`, bloc `volumes:`) :
#   - postgres-data  : comptes, rooms, métadonnées messages, base `invite_tokens`
#   - minio-data     : médias uploadés (chiffrés)
#   - synapse-data   : **clé de signature du homeserver** + état local
#
# Un `docker compose up -d --build` ne les touche pas : une MAJ de code/config garde
# la base. Ce qui les efface, c'est `docker compose down -v`, un `docker volume rm`,
# ou la reconstruction de la machine. Ce script couvre ce dernier cas : sauvegarder
# avant de détruire, restaurer sur la nouvelle machine.
#
# synapse-data est sauvegardé lui aussi, et ce n'est pas décoratif : perdre la clé de
# signature, c'est repartir avec une autre identité serveur — les événements déjà
# signés et la fédération ne s'y retrouvent plus. On garde la clé avec les données.
#
# Usage :
#   ./backup.sh backup  [DEST_DIR]         # défaut DEST_DIR = ./backups
#   ./backup.sh restore HORODATAGE [DIR]   # p.ex. restore 2026-10-08T20-30-00
#   ./backup.sh list    [DIR]
#
# À lancer depuis `infra/` sur le VPS, pile démarrée (postgres au moins).
# `COMPOSE_PROJECT` surcharge le nom de projet (défaut `tacita`, figé par `name:`
# dans le compose — c'est lui qui préfixe les volumes).
set -eu

PROJECT="${COMPOSE_PROJECT:-tacita}"
VOL_MINIO="${PROJECT}_minio-data"
VOL_SYNAPSE="${PROJECT}_synapse-data"

# .env pour POSTGRES_USER (le dump passe par l'utilisateur, pas par un rôle en dur).
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
require_pg() { : "${POSTGRES_USER:?POSTGRES_USER manquant (sourcer infra/.env, ou ENV_FILE=...)}"; }

# Conteneur alpine jetable pour archiver/restaurer le contenu d'un volume. Le répertoire
# hôte DOIT être absolu : `docker -v` rejette un chemin relatif.
tar_volume_out() { # <volume> <dir-hôte-absolu> <fichier>
  docker run --rm -v "$1":/data:ro -v "$2":/out alpine \
    tar czf "/out/$3" -C /data .
}
tar_volume_in() { # <volume> <dir-hôte-absolu> <fichier>
  # On vide le volume avant d'extraire : une restauration remplace l'état, elle ne le
  # fusionne pas avec des fichiers d'une version antérieure restés en place.
  docker run --rm -v "$1":/data -v "$2":/in alpine \
    sh -c "rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf \"/in/$3\" -C /data"
}

cmd_backup() {
  require_pg
  DEST="${1:-./backups}"
  STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
  mkdir -p "$DEST/$STAMP"
  OUT="$(cd "$DEST/$STAMP" && pwd)"   # absolu pour docker -v
  echo "→ sauvegarde dans $OUT"

  # pg_dumpall : toutes les bases (synapse + invite_tokens) et les rôles, d'un coup.
  # --clean --if-exists : le dump sait se re-appliquer sans empiler d'erreurs sur une
  # base déjà présente — une restauration ne doit jamais s'appliquer à moitié.
  # Une base par dump, pas `pg_dumpall` : la pile n'a qu'un rôle (POSTGRES_USER, recréé
  # depuis .env au boot), donc rien de global à sauver — et un dump mono-base n'émet ni
  # DROP ROLE ni DROP DATABASE, les deux seules choses qu'une restauration ne peut pas
  # rejouer en étant connectée dessus.
  #
  # Pas de `| gzip` : en sh le code retour d'un pipe est celui de gzip, qui réussit même
  # si pg_dump a planté — on écrirait un backup vide sans que `set -e` bronche. On dumpe
  # dans un fichier (échec attrapé), puis on compresse.
  for db in synapse invite_tokens; do
    echo "  postgres/$db…"
    docker compose exec -T postgres \
      pg_dump -U "$POSTGRES_USER" --clean --if-exists "$db" > "$OUT/db-$db.sql"
    gzip "$OUT/db-$db.sql"
  done

  # ponytail: tar à chaud des volumes (minio/synapse-data sont vivants). Suffisant ici —
  # la clé de synapse-data est statique, les médias sont immuables une fois écrits. Si un
  # jour il faut une photo strictement cohérente : `docker compose stop` avant ces deux.
  echo "  minio…"
  tar_volume_out "$VOL_MINIO" "$OUT" minio.tar.gz

  echo "  synapse-data…"
  tar_volume_out "$VOL_SYNAPSE" "$OUT" synapse.tar.gz

  echo "✓ terminé"
  ls -lh "$OUT"
}

cmd_restore() {
  require_pg
  STAMP="${1:?usage: restore HORODATAGE [DIR]}"
  BASE="${2:-./backups}"
  [ -d "$BASE/$STAMP" ] || { echo "introuvable : $BASE/$STAMP" >&2; exit 1; }
  DIR="$(cd "$BASE/$STAMP" && pwd)"   # absolu pour docker -v
  echo "→ restauration depuis $DIR"
  echo "  ⚠ écrase l'état actuel (DB + volumes). Ctrl-C pour annuler."

  # On coupe tout ce qui écrit dans postgres ; postgres reste debout pour avaler le dump.
  echo "  arrêt des services applicatifs…"
  docker compose stop synapse invite-tokens push-gateway

  # ON_ERROR_STOP=1 : un dump mono-base ne contient que du DROP/CREATE d'objets internes
  # (IF EXISTS), donc la moindre erreur est une vraie erreur — la restauration s'arrête au
  # lieu de laisser une base à moitié peuplée en se disant OK.
  for db in synapse invite_tokens; do
    echo "  postgres/$db…"
    gunzip -c "$DIR/db-$db.sql.gz" | docker compose exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db"
  done

  echo "  minio…"
  docker compose stop minio
  tar_volume_in "$VOL_MINIO" "$DIR" minio.tar.gz

  echo "  synapse-data…"
  tar_volume_in "$VOL_SYNAPSE" "$DIR" synapse.tar.gz

  echo "  redémarrage de la pile…"
  docker compose up -d
  echo "✓ restauré depuis $STAMP"
}

cmd_list() {
  DIR="${1:-./backups}"
  if [ -d "$DIR" ]; then ls -1 "$DIR"; else echo "aucune sauvegarde dans $DIR"; fi
}

case "${1:-}" in
  backup)  shift; cmd_backup  "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  list)    shift; cmd_list    "$@" ;;
  *) echo "usage: $0 {backup [DIR] | restore HORODATAGE [DIR] | list [DIR]}" >&2; exit 2 ;;
esac
