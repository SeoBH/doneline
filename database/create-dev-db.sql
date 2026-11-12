-- 개발 DB 생성용 초기 SQL. 새 환경을 준비할 때 관리 계정으로 실행한다. 업무 스키마는 번호순 마이그레이션으로 별도 적용한다.
\set ON_ERROR_STOP on
SELECT 'CREATE DATABASE cpjt_dev'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cpjt_dev')
\gexec
\connect cpjt_dev
SELECT current_database() AS database_name, version() AS server_version;
