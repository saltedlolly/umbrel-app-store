FROM python:3.14-alpine

WORKDIR /app

# Standard library only, so there is nothing to install
COPY watcher.py ./

# Run as the same user as the config tool, which owns the files in /data
USER 1000:1000

CMD ["python3", "-u", "/app/watcher.py"]
