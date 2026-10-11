FROM decolua/9router:latest
COPY entrypoint.sh /entrypoint.sh
COPY sync.mjs /sync.mjs
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
