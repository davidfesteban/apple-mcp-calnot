.PHONY: help start stop clean

help:
	@printf "Targets:\n"
	@printf "  make start  Start/rebuild the Docker Compose stack\n"
	@printf "  make stop   Stop the Docker Compose stack\n"
	@printf "  make clean  Stop and remove containers, networks, and volumes\n"

start:
	docker compose up -d --build

stop:
	docker compose down --remove-orphans

clean:
	docker compose down -v --remove-orphans
