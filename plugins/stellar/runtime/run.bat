@echo off
cd /d "%~dp0"
if defined DSH_HOME set "STELLAR_EMBED_DISCOVERY=%DSH_HOME%\stellar\embedding-service.json"
set "STELLAR_EMBED_PORT=18765"
set "STELLAR_EMBED_DEFAULT_MODEL=bge-m3"
node embedding-service.mjs > service.log 2>&1
