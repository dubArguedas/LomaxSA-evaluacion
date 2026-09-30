-- Creacion de Tabla Categorias

CREATE TABLE IF NOT EXISTS categorias (

    categoria_id SERIAL PRIMARY KEY,

    nombre VARCHAR(100) NOT NULL UNIQUE

);



-- Creacion de Tabla Productos con restricciones requeridas

CREATE TABLE IF NOT EXISTS productos (

    producto_id SERIAL PRIMARY KEY,

    codigo VARCHAR(50) NOT NULL UNIQUE,

    nombre VARCHAR(150) NOT NULL,

    descripcion TEXT,

    precio NUMERIC(10,2) NOT NULL CHECK (precio >= 0),

    categoria_id INT NOT NULL,

    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    estado VARCHAR(20) DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PUBLICADO')),

    CONSTRAINT fk_categoria FOREIGN KEY (categoria_id) REFERENCES categorias(categoria_id)

);



-- Carga inicial de las 3 Categorias solicitadas

INSERT INTO categorias (categoria_id, nombre) VALUES 

(1, 'Periféricos'),

(2, 'Monitores'),

(3, 'Almacenamiento')

ON CONFLICT (categoria_id) DO NOTHING;
