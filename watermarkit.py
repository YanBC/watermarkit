import argparse
import cv2 as cv



def get_args():
    p = argparse.ArgumentParser(description="Watermark an image with a text")
    p.add_argument("image_path", help="Image to watermark")
    p.add_argument("text", help="Text to watermark with")
    return p.parse_args()


def write_text_at_centre(canvas, centre, text, thickness, font_scale, color):
    centre_x, centre_y = centre
    textSize, baseLine = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    baseLine += thickness

    text_origin_x = centre_x - textSize[0] // 2
    text_origin_y = centre_y + textSize[1] // 2

    line_origin_x = text_origin_x
    line_origin_y = text_origin_y + 2 * thickness
    line_end_x = text_origin_x + textSize[0]
    line_end_y = line_origin_y

    cv.line(canvas, (line_origin_x, line_origin_y), (line_end_x, line_end_y), color, thickness)
    cv.putText(canvas, text, (text_origin_x, text_origin_y), cv.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness)
    return canvas


def watermark(image, text,
              thickness=1, font_scale=0.5, color=(236, 236, 238)):
    canvas = image.copy()
    image_h, image_w, _ = image.shape

    textSize, _ = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    textSize_w, textSize_h = textSize

    gridSize_w = textSize_w * 3
    gridSize_h = textSize_h * 6

    num_x = image_w // gridSize_w + 1
    num_y = image_h // gridSize_h + 1
    print("grid size:", num_x, num_y)

    for i in range(num_x):
        for j in range(num_y):
            grid_centre_x = int(gridSize_w / 2 + i * gridSize_w)
            grid_centre_y = int(gridSize_h / 2 + j * gridSize_h)
            canvas = write_text_at_centre(canvas, (grid_centre_x, grid_centre_y), text, thickness, font_scale, color)

    return canvas


if __name__ == '__main__':
    # args = get_args()
    # image_path = args.image_path
    # text = args.text

    # image = cv.imread(image_path)
    # assert image is not None, "Image not found"
    # watermarked = watermark(image, text)

    # test
    image_path = "imgs/demo_id.jpg"
    text = "WatermarkIt"
    # text = "风从月中来"

    image = cv.imread(image_path)
    import numpy as np
    image = np.zeros((500, 500, 3)).astype(np.uint8)
    assert image is not None, "Image not found"
    watermarked = watermark(image, text)

    cv.imshow("Watermarked", watermarked)
    cv.waitKey()
