#!/usr/bin/env bash
# Despliega el escritorio de prueba GESTORA en Cloud Run.
# Se corre en Cloud Shell, desde la carpeta escritorio/ del repositorio:
#   bash desplegar.sh
# Genera (una sola vez) el token del evaluador y la contraseña VNC, y los guarda en ~/escritorio-env.txt
# para que un segundo despliegue use los mismos valores y el .env del PC no se desactualice.
set -euo pipefail

PROJECT="${PROJECT:-agente-frontier}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-escritorio-prueba}"
ARCHIVO="$HOME/escritorio-env.txt"

if [[ -f "$ARCHIVO" ]]; then
  echo "Usando el token y la contraseña ya generados en $ARCHIVO"
  DESKTOP_TOKEN="$(grep '^DESKTOP_TOKEN=' "$ARCHIVO" | cut -d'"' -f2)"
  DESKTOP_PASSWORD="$(grep '^DESKTOP_PASSWORD=' "$ARCHIVO" | cut -d'"' -f2)"
else
  DESKTOP_TOKEN="$(openssl rand -hex 24)"
  # VNC usa como máximo 8 caracteres de la contraseña. (Sin tuberías: con pipefail, "tr | head" moría en silencio.)
  DESKTOP_PASSWORD="$(openssl rand -hex 4)"
fi

echo "== 1/3 Construyendo y desplegando $SERVICE (tarda unos minutos) =="
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated \
  --execution-environment gen2 \
  --no-cpu-throttling \
  --min-instances 0 --max-instances 1 \
  --cpu 1 --memory 1Gi \
  --timeout 3600 \
  --set-env-vars "DESKTOP_TOKEN=${DESKTOP_TOKEN},VNC_PASSWORD=${DESKTOP_PASSWORD}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
HOST="${URL#https://}"

cat > "$ARCHIVO" <<EOF
DESKTOP_HTTP_URL="$URL"
DESKTOP_WS_URL="wss://$HOST/websockify"
DESKTOP_TOKEN="$DESKTOP_TOKEN"
DESKTOP_PASSWORD="$DESKTOP_PASSWORD"
EOF
chmod 600 "$ARCHIVO"

echo "== 2/3 Comprobando que el escritorio responde =="
curl -sS --max-time 90 "$URL/health" && echo

echo "== 3/3 El agente usa 4 variantes de OCR: se le permiten 4 procesos a la vez =="
gcloud run services update agente-frontier --project "$PROJECT" --region "$REGION" \
  --update-env-vars OCR_MAX_PROCS=4 --quiet

echo
echo "LISTO. Copia estas 4 líneas en el archivo .env de tu PC, reemplazando las líneas DESKTOP_ que ya tiene:"
echo "-----------------------------------------------------------------------------------------"
cat "$ARCHIVO"
echo "-----------------------------------------------------------------------------------------"
echo "Escritorio en vivo (solo mirar): $URL/ver   (contraseña: la de DESKTOP_PASSWORD)"
