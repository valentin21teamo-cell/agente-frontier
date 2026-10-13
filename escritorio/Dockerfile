FROM debian:bookworm-slim
# Pantalla virtual, VNC, Tk y el servidor web (todo de los repositorios de Debian).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-tk python3-aiohttp xvfb x11vnc xkb-data x11-xkb-utils fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app ./app
COPY web ./web
COPY servidor.py ./
ENV PORT=8080 TRABAJO_DIR=/tmp/gestora PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
CMD ["python3", "servidor.py"]
