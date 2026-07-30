FROM node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37

ARG SOURCE_REPOSITORY
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY \
      org.opencontainers.image.revision=$SOURCE_COMMIT

RUN npm install -g opencode-ai@1.18.7 \
  && useradd -m -u 10001 opencode \
  && mkdir -p /home/opencode/.local/share /home/opencode/.local/state \
  && chown -R opencode:opencode /home/opencode/.local

COPY opencode/render-config.mjs /opt/opencode/render-config.mjs
COPY opencode/web-entry.mjs /opt/opencode/web-entry.mjs
COPY opencode/auth.mjs /opt/opencode/auth.mjs
COPY opencode/lib /opt/opencode/lib
COPY opencode/ui /opt/opencode/ui
COPY --chown=10001:10001 opencode/web-config /home/opencode/.config/opencode

USER opencode
ENV HOME=/home/opencode \
    XDG_CONFIG_HOME=/home/opencode/.config \
    XDG_DATA_HOME=/home/opencode/.local/share \
    OPENCODE_PROFILE=web
WORKDIR /home/opencode/workspace
EXPOSE 4096
ENTRYPOINT ["node", "/opt/opencode/render-config.mjs"]
CMD ["node", "/opt/opencode/web-entry.mjs"]
