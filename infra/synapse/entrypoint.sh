#!/bin/sh
set -eu

# homeserver.yaml n'est pas templaté nativement par l'image officielle (start.py ne
# fait que vérifier son existence) : on rend nous-mêmes les ${VAR} avant de démarrer.
envsubst < /conf/homeserver.yaml.tmpl > /data/homeserver.yaml
# Enregistrements d'application services, montés par les overlays qui en apportent
# (`rtc/` : lk-jwt-service). Même rendu que la config : leurs jetons viennent du `.env`.
mkdir -p /data/appservice
for modele in /conf/appservice/*.yaml.tmpl; do
  [ -e "$modele" ] || continue
  envsubst < "$modele" > "/data/appservice/$(basename "$modele" .tmpl)"
done

# start.py bascule sur l'uid 991 quand il tourne en root (cf. son propre code) ; /data
# doit lui appartenir pour qu'il puisse y écrire ses clés générées au premier démarrage.
chown -R 991:991 /data

exec /start.py "$@"
