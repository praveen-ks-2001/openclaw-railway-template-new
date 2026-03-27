#!/bin/bash
set -e
chown -R openclaw:openclaw /data
chmod 700 /data
if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi
rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew
openclaw config set defaultModel nvidia/nemotron-3-super-120b-a12b:free
exec gosu openclaw node src/server.js
