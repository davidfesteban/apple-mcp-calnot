.PHONY: help start stop clean

help:
	@printf "Targets:\n"
	@printf "  make start  Start the Docker Compose stack without rebuilding\n"
	@printf "  make stop   Stop the Docker Compose stack\n"
	@printf "  make clean  Stop and remove containers, networks, and volumes\n"

start:
	docker compose up -d

stop:
	docker compose down --remove-orphans

clean:
	docker compose down -v --remove-orphans
